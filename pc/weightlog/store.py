"""SQLite persistence. Item ids from the watch are the dedupe keys.

Schema follows the spec's tables, weight-only for v0; sessions/sets land later.
"""
from __future__ import annotations

import logging
import re
import sqlite3

log = logging.getLogger("weightlog.store")

KG_MIN, KG_MAX = 30.0, 250.0
TS_MIN = 1577836800  # 2020-01-01
ID_RE = re.compile(r"^[0-9a-fA-F-]{8,64}$")

SCHEMA = """
CREATE TABLE IF NOT EXISTS body_weights (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    kg REAL NOT NULL,
    ts INTEGER NOT NULL,
    received_at INTEGER NOT NULL,
    clock_offset_s INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS voice_memos (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    secs INTEGER NOT NULL,
    bytes INTEGER NOT NULL,
    path TEXT NOT NULL,
    received_at INTEGER NOT NULL
);
-- Post-processing progress, one row per memo. Each step is recorded on its own
-- so a failure in any of them can be retried without repeating the others.
CREATE TABLE IF NOT EXISTS memo_processing (
    id TEXT PRIMARY KEY,
    ogg_path TEXT,
    remote_path TEXT,
    uploaded_at INTEGER,
    transcript TEXT,
    transcribed_at INTEGER,
    appended_at INTEGER,
    error TEXT
);
CREATE TABLE IF NOT EXISTS sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL,
    accepted INTEGER NOT NULL,
    duplicated INTEGER NOT NULL,
    rejected INTEGER NOT NULL,
    error TEXT
);
"""


class Store:
    def __init__(self, path: str):
        self.conn = sqlite3.connect(path)
        self.conn.executescript(SCHEMA)
        self.conn.commit()

    def close(self) -> None:
        self.conn.close()

    @staticmethod
    def _validate(item: object, now: int, clock_offset_s: int) -> tuple[str, float, int] | str:
        """Returns (id, kg, corrected_ts) or a rejection reason."""
        if not isinstance(item, dict):
            return "malformed"
        item_id, kg, ts = item.get("i"), item.get("k"), item.get("t")
        if not isinstance(item_id, str) or not ID_RE.match(item_id):
            return "bad id"
        if not isinstance(kg, (int, float)) or not (KG_MIN <= kg <= KG_MAX):
            return "kg out of range"
        if not isinstance(ts, (int, float)):
            return "bad ts"
        corrected = int(ts) + clock_offset_s
        if not (TS_MIN <= corrected <= now + 86400):
            return "ts out of range"
        return (item_id, float(kg), corrected)

    def insert_weights(
        self, items: list, device_id: str, clock_offset_s: int, now: int
    ) -> tuple[list[str], list[str], list[list[str]]]:
        """Insert a batch in one transaction. Returns (accepted, duplicate, rejected) ids.

        Committed before returning, so the batch_ack built from the result is
        only ever sent for durable data (spec: ack after commit).
        """
        accepted: list[str] = []
        duplicate: list[str] = []
        rejected: list[list[str]] = []
        with self.conn:  # one transaction per batch
            for item in items:
                result = self._validate(item, now, clock_offset_s)
                if isinstance(result, str):
                    item_id = item.get("i", "?") if isinstance(item, dict) else "?"
                    rejected.append([str(item_id), result])
                    continue
                item_id, kg, ts = result
                cur = self.conn.execute(
                    "INSERT OR IGNORE INTO body_weights (id, device_id, kg, ts, received_at, clock_offset_s)"
                    " VALUES (?, ?, ?, ?, ?, ?)",
                    (item_id, device_id, kg, ts, now, clock_offset_s),
                )
                (accepted if cur.rowcount else duplicate).append(item_id)
        return accepted, duplicate, rejected

    def log_sync(
        self,
        device_id: str,
        started_at: int,
        ended_at: int,
        accepted: int,
        duplicated: int,
        rejected: int,
        error: str | None,
    ) -> None:
        with self.conn:
            self.conn.execute(
                "INSERT INTO sync_log (device_id, started_at, ended_at, accepted, duplicated, rejected, error)"
                " VALUES (?, ?, ?, ?, ?, ?, ?)",
                (device_id, started_at, ended_at, accepted, duplicated, rejected, error),
            )

    def memo_exists(self, memo_id: str) -> bool:
        row = self.conn.execute(
            "SELECT 1 FROM voice_memos WHERE id = ?", (memo_id,)
        ).fetchone()
        return row is not None

    def insert_memo(
        self,
        memo_id: str,
        device_id: str,
        ts: int,
        secs: int,
        byte_len: int,
        path: str,
        now: int,
    ) -> bool:
        """Record a stored memo. False if the id was already known."""
        with self.conn:
            cur = self.conn.execute(
                "INSERT OR IGNORE INTO voice_memos (id, device_id, ts, secs, bytes, path, received_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?)",
                (memo_id, device_id, ts, secs, byte_len, path, now),
            )
        return bool(cur.rowcount)

    # ── memo post-processing ─────────────────────────────────────────────────
    def memos_needing_work(self) -> list[tuple]:
        """(id, ts, secs, path) for memos not yet uploaded, transcribed and filed."""
        return self.conn.execute(
            "SELECT m.id, m.ts, m.secs, m.path FROM voice_memos m"
            " LEFT JOIN memo_processing p ON p.id = m.id"
            " WHERE p.id IS NULL OR p.uploaded_at IS NULL OR p.appended_at IS NULL"
            " ORDER BY m.ts"
        ).fetchall()

    def memo_state(self, memo_id: str) -> dict:
        row = self.conn.execute(
            "SELECT ogg_path, remote_path, uploaded_at, transcript, transcribed_at, appended_at, error"
            " FROM memo_processing WHERE id = ?",
            (memo_id,),
        ).fetchone()
        if row is None:
            return {}
        keys = ("ogg_path", "remote_path", "uploaded_at", "transcript", "transcribed_at", "appended_at", "error")
        return dict(zip(keys, row))

    def _upsert_memo_processing(self, memo_id: str, **fields) -> None:
        assignments = ", ".join(f"{k} = ?" for k in fields)
        with self.conn:
            self.conn.execute("INSERT OR IGNORE INTO memo_processing (id) VALUES (?)", (memo_id,))
            self.conn.execute(
                f"UPDATE memo_processing SET {assignments} WHERE id = ?",
                (*fields.values(), memo_id),
            )

    def mark_memo_uploaded(self, memo_id: str, ogg_path: str, remote_path: str, when: int) -> None:
        self._upsert_memo_processing(
            memo_id, ogg_path=ogg_path, remote_path=remote_path, uploaded_at=when, error=None
        )

    def mark_memo_transcribed(self, memo_id: str, transcript: str, when: int) -> None:
        self._upsert_memo_processing(memo_id, transcript=transcript, transcribed_at=when, error=None)

    def mark_memo_appended(self, memo_id: str, when: int) -> None:
        self._upsert_memo_processing(memo_id, appended_at=when, error=None)

    def mark_memo_error(self, memo_id: str, message: str) -> None:
        self._upsert_memo_processing(memo_id, error=message)

    def weights(self, limit: int = 50) -> list[tuple]:
        return self.conn.execute(
            "SELECT ts, kg, device_id FROM body_weights ORDER BY ts DESC LIMIT ?", (limit,)
        ).fetchall()
