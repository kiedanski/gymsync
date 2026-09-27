"""Push the daemon's database into tilde's health inbox.

tilde watches `files/health/_inbox/` and, when a sqlite file lands there, runs
its own exporter over it (crates/tilde-health) to regenerate the monthly CSVs
under `health/weight/`. That is the same path Gadgetbridge takes, so the
daemon's whole job here is to drop a consistent snapshot in that directory:
parsing, local-time bucketing and idempotency all belong to tilde.

Deliberately stdlib-only — the daemon's other dependency is bless, and a
once-per-sync PUT does not justify pulling in requests.
"""
from __future__ import annotations

import base64
import logging
import sqlite3
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

log = logging.getLogger("weightlog.tilde")

TIMEOUT_S = 60


def _snapshot(db_path: str, dest: str) -> None:
    """Consistent copy of a live SQLite database.

    Never copy the file byte-wise: a snapshot taken mid-transaction can carry a
    torn page, and tilde would then refuse to open it.
    """
    src = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        out = sqlite3.connect(dest)
        try:
            src.backup(out)
        finally:
            out.close()
    finally:
        src.close()


def upload(db_path: str, cfg: dict) -> bool:
    """PUT a snapshot of the database to tilde. Returns True on success.

    Never raises. A sync that reached SQLite is already durable and has been
    acked to the watch; an unreachable tilde must not turn that into a failure.
    """
    url = cfg.get("tilde_url")
    password = cfg.get("tilde_app_password")
    if not url or not password:
        return False

    tmp = Path(tempfile.gettempdir()) / "weightlog-upload.db"
    try:
        _snapshot(db_path, str(tmp))
        body = tmp.read_bytes()
    except Exception:
        log.warning("snapshot for tilde upload failed", exc_info=True)
        return False
    finally:
        tmp.unlink(missing_ok=True)

    # tilde's DAV accepts any username; the app password carries the scope.
    user = cfg.get("tilde_user", "weightlog")
    credentials = base64.b64encode(f"{user}:{password}".encode()).decode()
    req = urllib.request.Request(url, data=body, method="PUT")
    req.add_header("Authorization", "Basic " + credentials)
    req.add_header("Content-Type", "application/x-sqlite3")

    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
            log.info("pushed %d bytes to tilde (HTTP %s)", len(body), resp.status)
            return True
    except urllib.error.HTTPError as exc:
        log.warning("tilde rejected the upload: HTTP %s %s", exc.code, exc.reason)
    except Exception:
        log.warning("tilde upload failed", exc_info=True)
    return False
