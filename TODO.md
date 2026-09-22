# gymsync — next steps

Ordered by dependency; each phase gates the next. Items marked 🖐 need you +
the watch; the rest can be done from a keyboard.

## Phase 0 — prove it on hardware (one evening)

- [ ] Run the daemon on the Mac: `cd pc && .venv/bin/gymsync --config config.example.yaml -v`
- [ ] 🖐 Sideload `watch/dist/*.zab` on the GTR 4 via Gadgetbridge (File Installer)
- [ ] 🖐 Save a weight on the watch, hit SYNC → watch reaches "Listo"
  - If stuck on "Buscando PC": log the raw device objects in the `found`
    callback in `watch/libs/sync.js` and fix the name/field matching —
    easy-ble's scan-result shape is the least-documented piece
- [ ] Row visible: `sqlite3 pc/gymsync.db 'select * from body_weights;'` and
  pending count on Home drops to 0 (proves TX notifications/acks work)
- [ ] Dedupe under failure: kill the daemon mid-sync, restart, re-sync → still
  exactly one row per weigh-in
- [ ] 🖐 Repeat sync with the phone in range and Gadgetbridge connected —
  dual-role (peripheral to phone + central to PC) is the least-tested assumption
- [ ] Spec exit criterion: 10/10 sync cycles, advertising resumes unaided
- [ ] MTU experiment: raise `max_payload` (config + INFO) to 96, re-test; keep
  the highest value that works — note it in the README

## Phase 1 — daily use + Linux deployment (1–2 weeks passive)

- [ ] Pick the box (dobby is the obvious candidate) and check the adapter:
  `sudo btmgmt info` → "supported settings" must include `le` + `advertising`
- [ ] If the box's BT is busy or unsupported: dedicated CSR 4.0-clone USB dongle
- [ ] Deploy: clone repo, venv, `config.yaml` (set `adapter_index`,
  `power_cycle: true`), install `pc/gymsync.service`, enable + start
- [ ] After first sync: copy the device id from the daemon log into
  `allowed_devices`, set `allow_all_devices: false`
- [ ] 🖐 Weigh in daily for 1–2 weeks; watch `journalctl -u gymsync` for
  advertising-restart failures (the BlueZ #644 mitigation earning its keep)
- [ ] Commit the scaffold + any hardware fixes to git

## Phase 2 — grow into the full gym logger (per the spec, amended)

- [ ] Update the spec doc first: per-type dedupe semantics (sessions upsert
  `ended_at`, sets tombstone-wins for undo), size-based batching (~3.5 KB cap,
  not "20 items"), paged catalog message, name-in-scan-response
- [ ] Exercise catalog: YAML on the PC, versioned `catalog` message, shown on
  the watch (Elegir ejercicio screen)
- [ ] Sessions + sets: Entrenar/Set screens, undo-within-30s, move the queue
  from localStorage to `queue.jsonl` on `@zos/fs` with compaction
- [ ] Postgres behind the same Store interface (SQLite stays for dev)
- [ ] Exit criterion: one full gym week logged only with the watch

## Phase 3 — v2 (park until Phase 2 has survived a month)

- [ ] App Service background sync (no manual SYNC tap)
- [ ] Notion export / dashboard
- [ ] RPE: nullable column already cheap to add on the PC; watch UI only if
  you actually miss it
