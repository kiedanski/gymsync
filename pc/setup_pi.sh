#!/usr/bin/env bash
# One-shot weightlog setup for a Raspberry Pi (Raspberry Pi OS Bookworm or Ubuntu).
# Idempotent — safe to re-run. Run on the Pi as the login user:
#
#   TS_AUTHKEY=tskey-auth-... bash setup_pi.sh
#
# Without TS_AUTHKEY, `tailscale up` prints a login URL to authorize manually.
# Afterwards, disable key expiry for this node in the Tailscale admin console
# (Machines -> ... -> Disable key expiry) so it never drops off the tailnet.
set -euo pipefail

REPO_URL="https://github.com/kiedanski/gymsync.git"
WORKSPACE="$HOME/workspace"
APP_DIR="$WORKSPACE/weightlog"

echo "==> apt packages"
sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
    git curl python3 python3-venv python3-pip bluez bluez-tools sqlite3

python3 - <<'EOF'
import sys
v = sys.version_info
assert v >= (3, 10), (
    f"python {sys.version.split()[0]} is too old; weightlog needs >=3.10. "
    "Reflash with Raspberry Pi OS Bookworm (or newer)."
)
EOF

echo "==> bluetooth adapter"
# A fresh Raspberry Pi OS image ships the radio rfkill soft-blocked, which makes
# BlueZ reject every advertisement registration ("Failed to add advertisement:
# Rejected (0x0b)") even though bluetooth.service looks healthy.
sudo rfkill unblock bluetooth || true
sudo sed -i 's/^#\?AutoEnable=.*/AutoEnable=true/' /etc/bluetooth/main.conf
sudo systemctl restart bluetooth
sleep 2

echo "==> pairing agent"
# The GTR 4 demands an *authenticated* bond (LE Secure Connections numeric
# comparison): it advertises IO capability DisplayYesNo and aborts with
# "Numeric comparison failed (0x0c)" against a NoInputNoOutput peer, so plain
# Just Works does not work. bt-agent must therefore run as DisplayYesNo — but
# it then asks "Confirm passkey: NNNNNN (yes/no)?" on a console that a systemd
# unit does not have, so feed it a stream of "yes" to auto-confirm.
sudo tee /etc/systemd/system/bt-agent.service >/dev/null <<'UNIT'
[Unit]
Description=Bluetooth auto-confirming pairing agent (numeric comparison)
After=bluetooth.service
Requires=bluetooth.service

[Service]
Type=simple
ExecStartPre=/usr/bin/bluetoothctl pairable on
ExecStart=/bin/bash -c "yes yes | /usr/bin/bt-agent --capability=DisplayYesNo"
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now bt-agent

echo "==> tailscale"
if ! command -v tailscale >/dev/null 2>&1; then
    curl -fsSL https://tailscale.com/install.sh | sh
fi
if ! sudo tailscale status >/dev/null 2>&1; then
    if [ -n "${TS_AUTHKEY:-}" ]; then
        # --ssh lets you reach the Pi via Tailscale SSH even if sshd/keys break.
        sudo tailscale up --ssh --authkey "$TS_AUTHKEY"
    else
        echo "NOTE: TS_AUTHKEY not set — skipping 'tailscale up'. Run later:"
        echo "  sudo tailscale up --ssh --authkey tskey-auth-..."
    fi
fi

echo "==> clone/update repo"
mkdir -p "$WORKSPACE"
if [ -d "$APP_DIR/.git" ]; then
    git -C "$APP_DIR" pull --ff-only
else
    git clone "$REPO_URL" "$APP_DIR"
fi

echo "==> venv + install"
python3 -m venv "$APP_DIR/pc/.venv"
"$APP_DIR/pc/.venv/bin/pip" install --quiet --upgrade pip
"$APP_DIR/pc/.venv/bin/pip" install --quiet "$APP_DIR/pc"

echo "==> config + state dir"
sudo mkdir -p /etc/weightlog /var/lib/weightlog
if [ ! -f /etc/weightlog/config.yaml ]; then
    sudo cp "$APP_DIR/pc/config.example.yaml" /etc/weightlog/config.yaml
    # Persistent db outside the repo; enable the btmgmt power-cycle rescue
    # (Linux-only) since the daemon runs as root here.
    sudo sed -i 's|^db_path:.*|db_path: /var/lib/weightlog/weightlog.db|' /etc/weightlog/config.yaml
    sudo sed -i 's|^power_cycle:.*|power_cycle: true|' /etc/weightlog/config.yaml
fi

echo "==> systemd unit"
sudo tee /etc/systemd/system/weightlog.service >/dev/null <<UNIT
[Unit]
Description=weightlog BLE sync daemon (WeightLog watch)
After=bluetooth.service
Requires=bluetooth.service

[Service]
Type=simple
ExecStart=$APP_DIR/pc/.venv/bin/weightlog --config /etc/weightlog/config.yaml
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now weightlog

sleep 2
echo "==> status"
sudo systemctl status weightlog --no-pager -l | head -15 || true
echo
echo "Done. Logs: journalctl -u weightlog -f"
echo "Tailscale: $(tailscale ip -4 2>/dev/null || echo 'pending login — see URL above')"
