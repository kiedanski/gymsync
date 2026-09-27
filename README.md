# weightlog — GTR 4 → BLE → PC

Body-weight logger (v0 of the gym logger spec): a Zepp OS mini-app on the
Amazfit GTR 4 queues weigh-ins offline and syncs them over BLE to a Linux
daemon that validates, dedupes, and stores them in SQLite. No Zepp app, no
phone in the loop — the watch is BLE Central, the PC is a GATT peripheral.

```
watch/   Zepp OS device app (Zeus CLI project), sideloaded via Gadgetbridge
pc/      weightlog daemon: Python + bless (BlueZ on Linux, CoreBluetooth on macOS)
```

v0 scope is deliberately the thinnest full vertical slice: one data type
(body weight), the whole risky path (scan → connect → chunked JSON protocol →
ack → idempotent persistence). Sets/sessions/catalog reuse all of this.

## Watch app

```bash
cd watch
npm install
npm run build         # zeus build + scripts/fix_zab.py → dist/*.zab
```

Always build with `npm run build`, not bare `zeus build`: Gadgetbridge
requires a `deviceSource` field in the .zab's outer manifest platforms
(`ZeppOsFwHelper.handleZabPackage`), which zeus 1.9.3 omits — without the
post-processing step Gadgetbridge rejects the file as "not compatible with
the device". `scripts/fix_zab.py` injects the deviceSources from app.json.

Install the `.zab` on the GTR 4 through Gadgetbridge (File Installer → open the
`.zab`). The watch must already be Gadgetbridge-paired and on Zepp OS 3.x
(API_LEVEL ≥ 3.0 — the BLE master APIs need it; current GTR 4 firmware is 3.5).

Screens:
- **Home**: large weight readout with −0.1 / +0.1 steppers (drag the readout
  itself for long jumps), SAVE (vibrates, queues the item, then starts a sync
  on its own), SYNC, a pending-count badge, and a tappable `last … kg ›` line
  into History.
- **History**: recent readings newest first, six per page, each with its delta
  against the previous one. Backed by a local log in `libs/store.js` that
  survives sync (the pending queue is emptied on ack, so it cannot be the
  source); the PC keeps the full archive.
- **Sync**: status (buscando / conectando / enviando n de m / listo / error),
  REINTENTAR, VOLVER. Screen stays on for 2 min.

## PC daemon

```bash
cd pc
python3 -m venv .venv && .venv/bin/pip install -e .
cp config.example.yaml config.yaml
.venv/bin/weightlog --config config.yaml -v
```

Works on macOS too (bless uses CoreBluetooth) — handy for first end-to-end
tests before deploying to the Linux box. For Linux deployment there's a
systemd unit in `pc/weightlog.service` (adjust paths).

Linux prerequisites:
- BlueZ ≥ 5.48 (any current distro; no `--experimental` needed).
- Adapter must support the LE peripheral role: `sudo btmgmt info` →
  "supported settings" must include `le` and `advertising`.
- Strongly recommended: a **dedicated USB dongle** (CSR 4.0 clones are the
  best-evidenced cheap option) so the daemon can power-cycle "its" adapter
  without killing mouse/headphones. Set `adapter_index` + `power_cycle: true`.

Why the daemon rebuilds its advertisement after every session: BlueZ has an
acknowledged, unfixed bug ([bluez/bluez#644](https://github.com/bluez/bluez/issues/644))
where LE advertising silently stops after a central disconnects. The
supervisor loop in `server.py` + `Restart=always` in systemd is the mitigation.

Tests: `cd pc && python3 -m unittest discover -s tests`

## Protocol (v1)

One custom GATT service, three characteristics; JSON messages in chunks.

| Char | UUID suffix | Props | Use |
|------|-------------|-------|-----|
| RX   | …a1f1 | write | watch → PC chunks |
| TX   | …a1f2 | notify | acks (PC → watch) |
| INFO | …a1f3 | read | `{"v":1,"mp":16}` — protocol version + chunk payload |

Chunk = 4-byte header (`msg_id` LE16, `index` u8, `total` u8) + payload
(16 bytes by default = safe at un-negotiated MTU 23). Messages:
`hello`/`hello_ack` (version, device id, watch clock → offset correction),
`batch`/`batch_ack` (≤10 weight items; ack lists accepted/duplicate/rejected
ids, sent only after the SQLite commit), `bye`. The watch deletes queue items
only when acked as accepted or duplicate; retries reuse the same batch id, so
replays land as duplicates, never doubles.

## Hardware validation checklist (Phase 0, one gym session's worth)

Nobody has publicly documented a Zepp OS watch talking to a BlueZ GATT server
(closest prior art: the ESP32 example in
[zeppos-easy-ble](https://github.com/silver-zepp/zeppos-easy-ble)), so verify
in this order and expect to tweak:

1. **Scan**: does the PC show up? The scan-result device shape isn't firmly
   documented — if nothing matches, log the raw device objects in
   `watch/libs/sync.js` (`found` callback) and adjust the name/field matching.
2. **Write path**: one weigh-in, one sync. Watch shows "Listo", PC log shows
   the batch, `sqlite3 weightlog.db 'select * from body_weights;'` shows the row.
3. **Ack path**: pending count on Home drops to zero (TX notifications work).
4. **Retry/dedupe**: sync the same queue twice (kill the daemon mid-sync once);
   no duplicate rows.
5. **With Gadgetbridge connected**: repeat 2–3 with the phone in range —
   watch dual-role (peripheral to phone + central to PC) is reported to work
   but is the least-tested assumption.
6. **MTU**: if syncs feel slow, experiment with `max_payload` in config.yaml
   (the watch honors INFO's `mp`). At MTU 23 only 16 is safe; if the Zepp
   stack negotiates a higher MTU, 96+ speeds things up ~6×.

## Known limitations / next steps

- Queue lives in localStorage (fine for weigh-ins); move to `queue.jsonl` on
  `@zos/fs` when sets/sessions arrive, per the spec.
- `allow_all_devices: true` by default; flip to the allowlist after the first
  sync (device id appears in the daemon log).
- Advertising name fits the 31-byte legacy ADV packet only because `weightlog`
  is short; bless puts the name in scan response on most backends anyway.
- Next per spec: exercises catalog + sets + sessions (needs the per-type
  upsert semantics: sessions upsert `ended_at`, sets tombstone on undo),
  Postgres, App Service auto-sync, Notion export.
