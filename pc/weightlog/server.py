"""BLE GATT peripheral built on bless, wrapped in a supervisor loop.

BlueZ has an acknowledged, unfixed bug (bluez/bluez#644) where LE advertising
silently stops after a central disconnects and re-registering the same
advertisement can fail. Strategy here:
  - serve one sync session, then tear the whole bless server down and rebuild
    it (fresh advertisement registration);
  - rebuild too after 60 s of post-activity silence (watch walked away mid-sync);
  - after repeated consecutive failures, optionally power-cycle the adapter
    (btmgmt power off/on) before retrying;
  - systemd Restart=always as the last-resort backstop.
"""
from __future__ import annotations

import asyncio
import logging
import subprocess
import time

from bless import (
    BlessServer,
    GATTAttributePermissions,
    GATTCharacteristicProperties,
)

from .protocol import (
    INFO_UUID,
    RX_UUID,
    SVC_UUID,
    TX_UUID,
    Reassembler,
    SyncSession,
    encode_chunks,
    info_payload,
)
from .memo import MemoAssembler
from .store import Store
from . import tilde

log = logging.getLogger("weightlog.server")


class WeightLogServer:
    def __init__(self, config: dict):
        self.cfg = config
        self.store = Store(config["db_path"])
        memo_dir = config.get("memo_dir")
        self.assembler = MemoAssembler(memo_dir) if memo_dir else None
        self.failures = 0

    async def run(self) -> None:
        while True:
            try:
                await self._serve_once()
                self.failures = 0
            except asyncio.CancelledError:
                raise
            except Exception:
                self.failures += 1
                log.exception("server cycle failed (%d consecutive)", self.failures)
                if self.failures >= 3 and self.cfg.get("power_cycle", False):
                    self._power_cycle()
                    self.failures = 0
                await asyncio.sleep(3)

    async def _serve_once(self) -> None:
        loop = asyncio.get_running_loop()
        rx_queue: asyncio.Queue[bytes] = asyncio.Queue()
        server = BlessServer(name=self.cfg.get("name", "weightlog"), loop=loop)

        def on_write(characteristic, value, **kwargs):
            if str(characteristic.uuid).lower() == RX_UUID:
                loop.call_soon_threadsafe(rx_queue.put_nowait, bytes(value))

        def on_read(characteristic, **kwargs):
            return bytearray(characteristic.value or b"")

        server.write_request_func = on_write
        server.read_request_func = on_read

        await server.add_new_service(SVC_UUID)
        await server.add_new_characteristic(
            SVC_UUID,
            RX_UUID,
            GATTCharacteristicProperties.write,
            None,
            GATTAttributePermissions.writeable,
        )
        await server.add_new_characteristic(
            SVC_UUID,
            TX_UUID,
            GATTCharacteristicProperties.notify,
            None,
            GATTAttributePermissions.readable,
        )
        await server.add_new_characteristic(
            SVC_UUID,
            INFO_UUID,
            GATTCharacteristicProperties.read,
            info_payload(self.cfg.get("max_payload", 16)),
            GATTAttributePermissions.readable,
        )

        await server.start()
        log.info("advertising as %r, service %s", self.cfg.get("name", "weightlog"), SVC_UUID)
        try:
            session = await self._session_loop(server, rx_queue)
        finally:
            try:
                await server.stop()
            except Exception:
                log.warning("server.stop() failed", exc_info=True)
            log.info("server cycle ended, rebuilding advertisement")

        # Push only after the radio is down: on a Pi 3 the one antenna is
        # shared between BLE and Wi-Fi, so uploading while advertising would
        # have them fight. Only when something new actually landed.
        if session is not None and session.stats["accepted"]:
            await asyncio.to_thread(tilde.upload, self.cfg["db_path"], self.cfg)

    async def _session_loop(self, server: BlessServer, rx_queue: asyncio.Queue) -> SyncSession:
        reassembler = Reassembler(self.cfg.get("reassembly_timeout_s", 10))
        session = SyncSession(
            self.store,
            allowed_devices=self.cfg.get("allowed_devices", []),
            allow_all=self.cfg.get("allow_all_devices", False),
            assembler=self.assembler,
        )
        idle_timeout = self.cfg.get("idle_timeout_s", 60)
        msg_id = 1
        last_activity: float | None = None

        while True:
            try:
                timeout = idle_timeout if last_activity is not None else None
                chunk = await asyncio.wait_for(rx_queue.get(), timeout=timeout)
            except asyncio.TimeoutError:
                log.warning("connection went silent for %ds, recycling", idle_timeout)
                session._finish(time.time())
                return session
            now = time.time()
            last_activity = now
            for msg in reassembler.feed(chunk, now):
                for reply in session.handle(msg, now):
                    msg_id = await self._notify(server, reply, msg_id)
            if session.done:
                return session

    async def _notify(self, server: BlessServer, reply: dict, msg_id: int) -> int:
        """Send one message as paced notify chunks.

        CoreBluetooth (and BlueZ) keep a small notify queue; update_value
        returns False when it is full and the chunk is silently lost, so a
        burst of back-to-back chunks drops its tail and the watch can never
        reassemble the ack. Retry each chunk until accepted, with pacing.
        """
        char = server.get_characteristic(TX_UUID)
        for chunk in encode_chunks(msg_id, reply, self.cfg.get("max_payload", 16)):
            char.value = bytearray(chunk)
            for _ in range(40):
                if server.update_value(SVC_UUID, TX_UUID):
                    break
                await asyncio.sleep(0.05)
            else:
                log.warning("notify chunk dropped after retries (msg_id=%d)", msg_id)
            await asyncio.sleep(0.03)
        return (msg_id + 1) % 0xFFFF

    def _power_cycle(self) -> None:
        index = str(self.cfg.get("adapter_index", 0))
        log.warning("power-cycling adapter hci%s", index)
        for action in ("off", "on"):
            try:
                subprocess.run(
                    ["btmgmt", "--index", index, "power", action],
                    check=False,
                    capture_output=True,
                    timeout=10,
                )
            except (OSError, subprocess.TimeoutExpired):
                log.warning("btmgmt power %s failed", action, exc_info=True)
            time.sleep(1)
