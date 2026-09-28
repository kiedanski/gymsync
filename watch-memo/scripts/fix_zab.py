#!/usr/bin/env python3
"""Post-process the zeus-built .zab so Gadgetbridge accepts it.

Gadgetbridge's ZeppOsFwHelper.handleZabPackage() requires a "deviceSource"
int in every entry of manifest.json -> zpks[].platforms[]; zeus 1.9.3 (zpm
3.4.2) emits only screenType/screenResolution/cpuPlatform there, so
Gadgetbridge reports "selected file is not compatible with the device".
This injects the platforms declared in app.json into the outer manifest.
"""
import json
import pathlib
import shutil
import sys
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent


def main() -> None:
    app_json = json.loads((ROOT / "app.json").read_text())
    platforms = []
    for target in app_json["targets"].values():
        platforms.extend(target.get("platforms", []))
    if not platforms:
        sys.exit("no platforms found in app.json")

    zabs = sorted((ROOT / "dist").glob("*.zab"))
    if not zabs:
        sys.exit("no .zab in dist/ — run zeus build first")
    zab = zabs[-1]

    with zipfile.ZipFile(zab) as zf:
        entries = {info.filename: zf.read(info.filename) for info in zf.infolist()}

    manifest = json.loads(entries["manifest.json"])
    for zpk in manifest["zpks"]:
        merged = []
        for platform in platforms:
            entry = dict(zpk["platforms"][0]) if zpk.get("platforms") else {}
            entry.update(platform)  # adds name + deviceSource
            merged.append(entry)
        zpk["platforms"] = merged
    entries["manifest.json"] = json.dumps(manifest, separators=(",", ":")).encode()

    fixed = zab.with_suffix(".zab.tmp")
    with zipfile.ZipFile(fixed, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in entries.items():
            zf.writestr(name, data)
    shutil.move(fixed, zab)

    sources = [p["deviceSource"] for p in platforms]
    print(f"patched {zab.name}: platforms now carry deviceSources {sources}")


if __name__ == "__main__":
    main()
