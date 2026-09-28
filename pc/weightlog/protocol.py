"""Wire protocol shared with the watch app (see watch/libs/proto.js).

Chunk framing: 4-byte header (msg_id LE16, index u8, total u8) + payload.
One message = one UTF-8 JSON document, max 255 chunks.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any

from .memo import MAX_MEMO_BYTES, MAX_PARTS, MemoAssembler

log = logging.getLogger("weightlog.protocol")

PROTO_VERSION = 1

SVC_UUID = "b7c9a1f0-8e2d-4c5b-9a3e-d41f0c8b6e21"
RX_UUID = "b7c9a1f1-8e2d-4c5b-9a3e-d41f0c8b6e21"  # watch -> PC, write
TX_UUID = "b7c9a1f2-8e2d-4c5b-9a3e-d41f0c8b6e21"  # PC -> watch, notify
INFO_UUID = "b7c9a1f3-8e2d-4c5b-9a3e-d41f0c8b6e21"  # PC -> watch, read

HEADER_LEN = 4
MAX_CHUNKS = 255
CLOCK_TOLERANCE_S = 300


def encode_chunks(msg_id: int, obj: Any, payload_size: int) -> list[bytes]:
    data = json.dumps(obj, separators=(",", ":")).encode("utf-8")
    total = max(1, -(-len(data) // payload_size))
    if total > MAX_CHUNKS:
        raise ValueError(f"message too large: {len(data)} bytes")
    chunks = []
    for idx in range(total):
        part = data[idx * payload_size : (idx + 1) * payload_size]
        header = bytes((msg_id & 0xFF, (msg_id >> 8) & 0xFF, idx, total))
        chunks.append(header + part)
    return chunks


@dataclass
class _Partial:
    total: int
    parts: dict = field(default_factory=dict)
    first_seen: float = 0.0


class Reassembler:
    """Rebuilds messages from chunks; drops partials older than timeout."""

    def __init__(self, timeout_s: float = 10.0):
        self.timeout_s = timeout_s
        self._partials: dict[int, _Partial] = {}

    def feed(self, chunk: bytes, now: float) -> list[Any]:
        self._expire(now)
        if len(chunk) < HEADER_LEN + 1:
            return []
        msg_id = chunk[0] | (chunk[1] << 8)
        idx, total = chunk[2], chunk[3]
        if total == 0 or idx >= total:
            return []
        entry = self._partials.get(msg_id)
        if entry is None or entry.total != total:
            entry = _Partial(total=total, first_seen=now)
            self._partials[msg_id] = entry
        entry.parts.setdefault(idx, chunk[HEADER_LEN:])
        if len(entry.parts) < entry.total:
            return []
        del self._partials[msg_id]
        raw = b"".join(entry.parts[n] for n in range(entry.total))
        try:
            return [json.loads(raw.decode("utf-8"))]
        except (ValueError, UnicodeDecodeError):
            log.warning("dropping undecodable message msg_id=%d len=%d", msg_id, len(raw))
            return []

    def _expire(self, now: float) -> None:
        stale = [mid for mid, e in self._partials.items() if now - e.first_seen > self.timeout_s]
        for mid in stale:
            log.warning("dropping incomplete message msg_id=%d", mid)
            del self._partials[mid]


class SyncSession:
    """Handles one watch connection: hello -> batches -> bye.

    Feed complete messages in; get reply messages (to notify back) out.
    """

    def __init__(
        self,
        store,
        allowed_devices: list[str],
        allow_all: bool,
        assembler: "MemoAssembler | None" = None,
    ):
        self.store = store
        self.allowed = set(allowed_devices)
        self.allow_all = allow_all
        self.assembler = assembler
        self.memo_meta: dict[str, dict] = {}
        self.device_id: str | None = None
        self.clock_offset_s = 0
        self.started_at: float | None = None
        self.stats = {"accepted": 0, "duplicated": 0, "rejected": 0, "memos": 0}
        self.error: str | None = None
        self.done = False

    def handle(self, msg: Any, now: float) -> list[dict]:
        if not isinstance(msg, dict) or "m" not in msg:
            return []
        kind = msg["m"]
        if kind == "hello":
            return [self._hello(msg, now)]
        if kind == "batch":
            return [self._batch(msg, now)]
        if kind == "memo":
            return [self._memo(msg, now)]
        if kind == "memo_part":
            return [self._memo_part(msg, now)]
        if kind == "bye":
            self._finish(now)
            return []
        log.warning("unknown message type %r", kind)
        return []

    def _hello(self, msg: dict, now: float) -> dict:
        nack = {"m": "hello_ack", "ok": False, "v": PROTO_VERSION, "ts": int(now)}
        if msg.get("v") != PROTO_VERSION:
            self.error = f"protocol version {msg.get('v')}"
            return {**nack, "err": "version"}
        device = msg.get("d")
        if not isinstance(device, str) or not device:
            self.error = "missing device id"
            return {**nack, "err": "device"}
        if not self.allow_all and device not in self.allowed:
            self.error = f"device {device} not in allowlist"
            log.warning(self.error)
            return {**nack, "err": "device"}
        self.device_id = device
        self.started_at = now
        watch_ts = msg.get("ts")
        offset = int(now) - int(watch_ts) if isinstance(watch_ts, (int, float)) else 0
        # Spec: only correct timestamps when clocks differ by more than 5 min.
        self.clock_offset_s = offset if abs(offset) > CLOCK_TOLERANCE_S else 0
        if self.clock_offset_s:
            log.info("watch clock off by %ds, correcting timestamps", offset)
        log.info("hello from %s, %s pending", device, msg.get("p", "?"))
        return {"m": "hello_ack", "ok": True, "v": PROTO_VERSION, "ts": int(now), "off": self.clock_offset_s}

    def _batch(self, msg: dict, now: float) -> dict:
        batch_id = msg.get("b")
        if self.device_id is None:
            return {"m": "batch_ack", "b": batch_id, "acc": [], "dup": [], "rej": [["*", "no hello"]]}
        items = msg.get("w") or []
        acc, dup, rej = self.store.insert_weights(
            items, device_id=self.device_id, clock_offset_s=self.clock_offset_s, now=int(now)
        )
        self.stats["accepted"] += len(acc)
        self.stats["duplicated"] += len(dup)
        self.stats["rejected"] += len(rej)
        log.info("batch %s: %d accepted, %d duplicate, %d rejected", batch_id, len(acc), len(dup), len(rej))
        return {"m": "batch_ack", "b": batch_id, "acc": acc, "dup": dup, "rej": rej}

    def _memo(self, msg: dict, now: float) -> dict:
        """Open or resume a memo transfer. `have` tells the watch where to start."""
        memo_id = msg.get("id")
        nack = {"m": "memo_ack", "id": memo_id, "ok": False, "have": 0}
        if self.device_id is None:
            return {**nack, "err": "no hello"}
        if self.assembler is None:
            return {**nack, "err": "memos disabled"}
        if not MemoAssembler.valid_id(memo_id):
            return {**nack, "err": "bad id"}
        # Already stored: tell the watch it is done so it drops its copy.
        if self.store.memo_exists(memo_id):
            return {"m": "memo_ack", "id": memo_id, "ok": True, "done": True, "have": 0}

        total_parts, total_bytes = msg.get("parts"), msg.get("bytes")
        if not isinstance(total_parts, int) or not 0 < total_parts <= MAX_PARTS:
            return {**nack, "err": "bad parts"}
        if not isinstance(total_bytes, int) or not 0 < total_bytes <= MAX_MEMO_BYTES:
            return {**nack, "err": "bad bytes"}

        self.memo_meta[memo_id] = {
            "ts": int(msg.get("ts") or now) + self.clock_offset_s,
            "secs": int(msg.get("secs") or 0),
        }
        have = self.assembler.begin(memo_id, total_parts, total_bytes)
        log.info("memo %s: %d parts, %d bytes, resuming at %d", memo_id, total_parts, total_bytes, have)
        return {"m": "memo_ack", "id": memo_id, "ok": True, "have": have}

    def _memo_part(self, msg: dict, now: float) -> dict:
        memo_id, n = msg.get("id"), msg.get("n")
        if self.device_id is None or self.assembler is None:
            return {"m": "part_ack", "id": memo_id, "n": n, "ok": False, "have": 0}
        if not MemoAssembler.valid_id(memo_id) or not isinstance(n, int):
            return {"m": "part_ack", "id": memo_id, "n": n, "ok": False, "have": 0}

        ok, have = self.assembler.add_part(memo_id, n, msg.get("d") or "")
        reply = {"m": "part_ack", "id": memo_id, "n": n, "ok": ok, "have": have}
        if not ok or not self.assembler.is_complete(memo_id):
            return reply

        meta = self.memo_meta.get(memo_id, {})
        ts = int(meta.get("ts") or now)
        path = self.assembler.finalize(memo_id, ts)
        if path is None:
            return {**reply, "done": False, "err": "assembly failed"}
        self.store.insert_memo(
            memo_id,
            device_id=self.device_id,
            ts=ts,
            secs=int(meta.get("secs") or 0),
            byte_len=path.stat().st_size,
            path=str(path),
            now=int(now),
        )
        self.stats["memos"] += 1
        log.info("memo %s stored: %s (%d bytes)", memo_id, path.name, path.stat().st_size)
        return {**reply, "done": True}

    def _finish(self, now: float) -> None:
        if self.done:
            return
        self.done = True
        if self.device_id is not None:
            self.store.log_sync(
                device_id=self.device_id,
                started_at=int(self.started_at or now),
                ended_at=int(now),
                accepted=self.stats["accepted"],
                duplicated=self.stats["duplicated"],
                rejected=self.stats["rejected"],
                error=self.error,
            )
        log.info("sync finished: %s", self.stats)


def info_payload(max_payload: int) -> bytes:
    return json.dumps({"v": PROTO_VERSION, "mp": max_payload}, separators=(",", ":")).encode("utf-8")
