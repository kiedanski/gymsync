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

    def weights(self, limit: int = 50) -> list[tuple]:
        return self.conn.execute(
            "SELECT ts, kg, device_id FROM body_weights ORDER BY ts DESC LIMIT ?", (limit,)
        ).fetchall()
