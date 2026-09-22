from __future__ import annotations

import argparse
import asyncio
import logging
import sys

import yaml

from .server import GymSyncServer

DEFAULTS = {
    "name": "gymsync",
    "adapter_index": 0,
    "db_path": "gymsync.db",
    "max_payload": 16,
    "allow_all_devices": True,
    "allowed_devices": [],
    "idle_timeout_s": 60,
    "reassembly_timeout_s": 10,
    "power_cycle": False,
}


def cli() -> None:
    parser = argparse.ArgumentParser(prog="gymsync", description="BLE sync daemon for the GymLog watch app")
    parser.add_argument("--config", help="path to YAML config", default=None)
    parser.add_argument("--verbose", "-v", action="store_true")
    args = parser.parse_args()

    config = dict(DEFAULTS)
    if args.config:
        with open(args.config) as fh:
            config.update(yaml.safe_load(fh) or {})

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
        stream=sys.stdout,
    )

    try:
        asyncio.run(GymSyncServer(config).run())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    cli()
