"""Post-processing for received voice memos, kept out of the BLE daemon.

Transcription pins a core for minutes and the daemon must keep advertising on a
radio that already shares its antenna with Wi-Fi, so the two do not belong in
one process. This runs as its own service.

Each memo passes through four steps, each recorded separately so any one can be
retried without repeating the others:

    convert -> upload the audio to tilde -> transcribe -> append to the daily note

Nothing here is destructive: the received file is never modified, and the daily
note is only ever appended to, guarded by a per-memo marker so a retry cannot
duplicate an entry in something the user also writes in by hand.
"""
from __future__ import annotations

import base64
import datetime
import json
import logging
import pathlib
import subprocess
import time
import urllib.error
import urllib.request

from .opusconv import to_ogg_opus

log = logging.getLogger("weightlog.memoproc")

HTTP_TIMEOUT_S = 120
TRANSCRIBE_TIMEOUT_S = 1800  # measured ~6x realtime with base on a Pi 3; be patient


# ── tilde plumbing ───────────────────────────────────────────────────────────
def _dav_auth(cfg: dict) -> str | None:
    password = cfg.get("tilde_app_password")
    if not password:
        return None
    user = cfg.get("tilde_user", "weightlog")
    return "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode()


def _dav_mkcol(cfg: dict, base: str, auth: str, remote_dir: str) -> None:
    """Create each collection along the path. WebDAV PUT will not do it."""
    parts = [p for p in remote_dir.strip("/").split("/") if p]
    for i in range(1, len(parts) + 1):
        req = urllib.request.Request(f"{base}/{'/'.join(parts[:i])}", method="MKCOL")
        req.add_header("Authorization", auth)
        try:
            urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_S)
        except urllib.error.HTTPError as exc:
            if exc.code != 405:  # 405 = already exists, which is fine
                log.debug("MKCOL %s: HTTP %s", "/".join(parts[:i]), exc.code)
        except Exception:
            log.debug("MKCOL %s failed", "/".join(parts[:i]), exc_info=True)


def _dav_put(cfg: dict, remote_path: str, body: bytes) -> bool:
    base = (cfg.get("tilde_dav_base") or "").rstrip("/")
    auth = _dav_auth(cfg)
    if not base or not auth:
        return False

    def attempt() -> int | None:
        req = urllib.request.Request(f"{base}/{remote_path.lstrip('/')}", data=body, method="PUT")
        req.add_header("Authorization", auth)
        req.add_header("Content-Type", "audio/ogg")
        try:
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_S) as resp:
                return resp.status
        except urllib.error.HTTPError as exc:
            return exc.code
        except Exception:
            log.warning("upload of %s failed", remote_path, exc_info=True)
            return None

    status = attempt()
    if status == 409:
        # Parent collection missing; create the tree and try once more.
        _dav_mkcol(cfg, base, auth, remote_path.rsplit("/", 1)[0])
        status = attempt()

    if status is not None and 200 <= status < 300:
        log.info("uploaded %s (%d bytes, HTTP %s)", remote_path, len(body), status)
        return True
    log.warning("tilde rejected %s: HTTP %s", remote_path, status)
    return False


def _mcp(cfg: dict, tool: str, arguments: dict, quiet_errors: tuple = ()) -> dict | None:
    """Call one MCP tool. Wire names are dot-separated (`notes.append`)."""
    url = cfg.get("tilde_mcp_url")
    token = cfg.get("tilde_mcp_token")
    if not url or not token:
        return None
    payload = json.dumps(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": tool, "arguments": arguments},
        }
    ).encode()
    req = urllib.request.Request(url, data=payload, method="POST")
    req.add_header("Authorization", "Bearer " + token)
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_S) as resp:
            body = json.loads(resp.read().decode())
        if "error" in body:
            message = str(body["error"].get("message", ""))
            if any(q in message for q in quiet_errors):
                log.debug("mcp %s: %s", tool, message)
            else:
                log.warning("mcp %s failed: %s", tool, body["error"])
            return None
        return body.get("result")
    except Exception:
        log.warning("mcp %s failed", tool, exc_info=True)
        return None


# ── steps ────────────────────────────────────────────────────────────────────
def convert(src: pathlib.Path) -> pathlib.Path:
    """Repack the Zepp container as Ogg Opus, alongside the original."""
    dest = src.with_suffix(".ogg")
    if not dest.exists() or dest.stat().st_mtime < src.stat().st_mtime:
        packets = to_ogg_opus(src, dest)
        log.info("converted %s: %d packets, %.1fs", src.name, packets, packets * 0.02)
    return dest


def transcribe(cfg: dict, ogg: pathlib.Path) -> str | None:
    """Run whisper.cpp over the memo. Returns the text, or None if unavailable."""
    binary = cfg.get("whisper_bin")
    model = cfg.get("whisper_model")
    if not binary or not model:
        return None
    if not pathlib.Path(binary).exists() or not pathlib.Path(model).exists():
        log.warning("whisper not installed (%s / %s)", binary, model)
        return None

    # whisper.cpp wants 16 kHz mono PCM; the recorder is already 16 kHz mono,
    # so this only unpacks Opus rather than resampling.
    wav = ogg.with_suffix(".wav")
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", str(ogg), "-ar", "16000", "-ac", "1", str(wav)],
            check=True,
            capture_output=True,
            timeout=300,
        )
    except (OSError, subprocess.SubprocessError):
        log.warning("ffmpeg failed on %s", ogg.name, exc_info=True)
        return None

    try:
        proc = subprocess.run(
            [
                binary,
                "-m", model,
                "-l", cfg.get("whisper_lang", "es"),
                "-t", str(cfg.get("whisper_threads", 3)),  # leave a core for the daemon
                "-nt",                                      # no timestamps, just text
                "-f", str(wav),
            ],
            check=True,
            capture_output=True,
            timeout=TRANSCRIBE_TIMEOUT_S,
            text=True,
        )
    except (OSError, subprocess.SubprocessError):
        log.warning("whisper failed on %s", ogg.name, exc_info=True)
        return None
    finally:
        wav.unlink(missing_ok=True)

    text = " ".join(line.strip() for line in proc.stdout.splitlines() if line.strip())
    return text or None


def append_to_memos(cfg: dict, when: datetime.datetime, memo_id: str, text: str, audio_path: str) -> bool:
    """Append one memo to the single memo log.

    Deliberately its own file, which nothing else writes to. Appending into a
    note the user also edits is a write race against their Obsidian client with
    no merge: it overwrote a day's entries once already. One writer per file
    makes that impossible rather than unlikely.
    """
    note = (cfg.get("memo_note") or "notes/memos.md").strip("/")
    # Makes the append idempotent, so a retry cannot leave a second copy.
    marker = f"<!-- memo:{memo_id} -->"

    existing = _mcp(cfg, "notes.read", {"path": note}, quiet_errors=("note not found",))
    if existing and marker in json.dumps(existing):
        log.info("memo %s already in %s", memo_id, note)
        return True

    body = (
        f"\n{marker}\n"
        f"**{when.strftime('%Y-%m-%d %H:%M')}** 🎙 {text}\n"
        f"[audio]({audio_path})\n"
    )
    if existing is not None:
        if _mcp(cfg, "notes.append", {"path": note, "content": body}) is not None:
            log.info("appended memo %s to %s", memo_id, note)
            return True
        return False
    if _mcp(cfg, "notes.create", {"path": note, "content": "# Voice memos\n" + body}) is not None:
        log.info("created %s with memo %s", note, memo_id)
        return True
    return False


# ── driver ───────────────────────────────────────────────────────────────────
def process_once(store, cfg: dict) -> int:
    """Advance every unfinished memo as far as it can go. Returns work done."""
    memo_dir = cfg.get("memo_dir")
    if not memo_dir:
        return 0
    done = 0
    for memo_id, ts, secs, path in store.memos_needing_work():
        src = pathlib.Path(path)
        if not src.exists():
            log.warning("memo %s missing at %s", memo_id, path)
            store.mark_memo_error(memo_id, "file missing")
            continue
        when = datetime.datetime.fromtimestamp(ts)
        try:
            ogg = convert(src)
            remote = f"{(cfg.get('memo_dav_dir') or 'memos').strip('/')}/{when.strftime('%Y-%m')}/{ogg.name}"

            state = store.memo_state(memo_id)
            if not state.get("uploaded_at"):
                if _dav_put(cfg, remote, ogg.read_bytes()):
                    store.mark_memo_uploaded(memo_id, str(ogg), remote, int(time.time()))
                    done += 1

            state = store.memo_state(memo_id)
            transcript = state.get("transcript")
            if not transcript:
                transcript = transcribe(cfg, ogg)
                if transcript:
                    store.mark_memo_transcribed(memo_id, transcript, int(time.time()))
                    done += 1

            state = store.memo_state(memo_id)
            if state.get("transcript") and not state.get("appended_at"):
                if append_to_memos(cfg, when, memo_id, state["transcript"], remote):
                    store.mark_memo_appended(memo_id, int(time.time()))
                    done += 1
        except Exception:
            log.exception("memo %s failed", memo_id)
            store.mark_memo_error(memo_id, "exception")
    return done


def main() -> None:
    """Entry point for the weightlog-memos service."""
    import argparse
    import sys

    import yaml

    from .store import Store

    parser = argparse.ArgumentParser(prog="weightlog-memos", description="Voice memo post-processing")
    parser.add_argument("--config", required=True)
    parser.add_argument("--once", action="store_true", help="process what is pending and exit")
    parser.add_argument("--verbose", "-v", action="store_true")
    args = parser.parse_args()

    with open(args.config) as fh:
        cfg = yaml.safe_load(fh) or {}
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
        stream=sys.stdout,
    )
    store = Store(cfg["db_path"])
    if args.once:
        print(f"processed {process_once(store, cfg)} step(s)")
        return
    try:
        run(store, cfg)
    except KeyboardInterrupt:
        pass


def run(store, cfg: dict) -> None:
    interval = int(cfg.get("memo_poll_s", 60))
    log.info("memo processor started (every %ds)", interval)
    while True:
        try:
            process_once(store, cfg)
        except Exception:
            log.exception("memo processing cycle failed")
        time.sleep(interval)
