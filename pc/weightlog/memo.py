"""Assembly of voice memos arriving as numbered parts.

A memo does not fit in one protocol message: the chunk header's `total` is a
u8, so a message caps at 255 chunks (4 KB at the 16-byte payload), while the
watch records ~2.7 KB/s of Opus. A 15-second memo is therefore ~40 KB, about
fourteen messages, and roughly two minutes of link time.

Parts are appended to a partial file as they arrive, with progress recorded
beside it, so a connection that drops halfway resumes from the next missing
part instead of re-sending the whole memo. Ordering is strict: a part out of
sequence is refused and the reply carries the index actually wanted, which is
also how the watch discovers where to resume.
"""
from __future__ import annotations

import base64
import json
import logging
import pathlib
import re

log = logging.getLogger("weightlog.memo")

ID_RE = re.compile(r"^[0-9a-fA-F-]{8,64}$")
# Runaway guard, not a target: ~12 minutes of Opus at the measured rate.
MAX_MEMO_BYTES = 2 * 1024 * 1024
MAX_PARTS = 1024


class MemoAssembler:
    def __init__(self, memo_dir: str):
        self.dir = pathlib.Path(memo_dir)
        self.dir.mkdir(parents=True, exist_ok=True)

    # ── paths ────────────────────────────────────────────────────────────────
    def _partial(self, memo_id: str) -> pathlib.Path:
        return self.dir / f".{memo_id}.partial"

    def _meta(self, memo_id: str) -> pathlib.Path:
        return self.dir / f".{memo_id}.meta"

    def final_path(self, memo_id: str, ts: int) -> pathlib.Path:
        return self.dir / f"{ts}-{memo_id}.opus"

    # ── state ────────────────────────────────────────────────────────────────
    def _read_meta(self, memo_id: str) -> dict | None:
        try:
            return json.loads(self._meta(memo_id).read_text())
        except (OSError, ValueError):
            return None

    def _write_meta(self, memo_id: str, meta: dict) -> None:
        self._meta(memo_id).write_text(json.dumps(meta))

    def _reset(self, memo_id: str, total_parts: int, total_bytes: int) -> None:
        self._partial(memo_id).write_bytes(b"")
        self._write_meta(
            memo_id,
            {"parts": 0, "bytes": 0, "total_parts": total_parts, "total_bytes": total_bytes},
        )

    # ── protocol surface ─────────────────────────────────────────────────────
    @staticmethod
    def valid_id(memo_id: object) -> bool:
        return isinstance(memo_id, str) and bool(ID_RE.match(memo_id))

    def begin(self, memo_id: str, total_parts: int, total_bytes: int) -> int:
        """Start or resume a memo. Returns the part index wanted next."""
        meta = self._read_meta(memo_id)
        if (
            meta
            and meta.get("total_parts") == total_parts
            and meta.get("total_bytes") == total_bytes
            and self._partial(memo_id).exists()
        ):
            return int(meta.get("parts", 0))
        # First sight, or the id was reused for different content: start over.
        self._reset(memo_id, total_parts, total_bytes)
        return 0

    def add_part(self, memo_id: str, n: int, payload_b64: str) -> tuple[bool, int]:
        """Append part `n`. Returns (accepted, index wanted next)."""
        meta = self._read_meta(memo_id)
        if meta is None:
            return False, 0
        expected = int(meta.get("parts", 0))
        if n != expected:
            # Duplicate or gap: never write out of order, just restate position.
            return False, expected
        try:
            data = base64.b64decode(payload_b64, validate=True)
        except Exception:
            log.warning("memo %s part %d: undecodable base64", memo_id, n)
            return False, expected
        if meta["bytes"] + len(data) > min(MAX_MEMO_BYTES, meta["total_bytes"]):
            log.warning("memo %s part %d overruns declared size", memo_id, n)
            return False, expected
        with self._partial(memo_id).open("ab") as fh:
            fh.write(data)
        meta["parts"] = expected + 1
        meta["bytes"] += len(data)
        self._write_meta(memo_id, meta)
        return True, meta["parts"]

    def is_complete(self, memo_id: str) -> bool:
        meta = self._read_meta(memo_id)
        if meta is None:
            return False
        return meta["parts"] >= meta["total_parts"] and meta["bytes"] == meta["total_bytes"]

    def finalize(self, memo_id: str, ts: int) -> pathlib.Path | None:
        """Move the completed partial into place. Returns its path, or None."""
        meta = self._read_meta(memo_id)
        partial = self._partial(memo_id)
        if meta is None or not partial.exists():
            return None
        if partial.stat().st_size != meta["total_bytes"]:
            log.warning(
                "memo %s: assembled %d bytes, expected %d — discarding",
                memo_id,
                partial.stat().st_size,
                meta["total_bytes"],
            )
            self.discard(memo_id)
            return None
        dest = self.final_path(memo_id, ts)
        partial.replace(dest)
        self._meta(memo_id).unlink(missing_ok=True)
        return dest

    def discard(self, memo_id: str) -> None:
        self._partial(memo_id).unlink(missing_ok=True)
        self._meta(memo_id).unlink(missing_ok=True)
