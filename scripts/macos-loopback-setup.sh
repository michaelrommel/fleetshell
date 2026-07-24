#!/bin/bash
# FleetShell — macOS loopback alias setup
#
# This script installs a LaunchDaemon that adds loopback aliases
# 127.0.0.2 – 127.0.0.17 at every boot.  FleetShell uses these
# addresses to isolate concurrent tunnel sessions.
#
# Run once with sudo:
#   sudo bash macos-loopback-setup.sh
#
# To uninstall:
#   sudo bash macos-loopback-setup.sh --uninstall

set -euo pipefail

LABEL="com.fleetshell.loopback"
PLIST="/Library/LaunchDaemons/${LABEL}.plist"

# ── Uninstall ─────────────────────────────────────────────────────────────────
if [[ "${1:-}" == "--uninstall" ]]; then
    echo "Uninstalling FleetShell loopback daemon..."
    launchctl bootout system "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    # Remove the aliases from the live interface too
    for i in $(seq 2 17); do
        sudo ifconfig lo0 -alias "127.0.0.${i}" 2>/dev/null || true
    done
    echo "Done. Aliases removed."
    exit 0
fi

# ── Require root ──────────────────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
    echo "Please run with sudo:"
    echo "  sudo bash $0"
    exit 1
fi

# ── Write the LaunchDaemon plist ──────────────────────────────────────────────
echo "Installing FleetShell loopback daemon to ${PLIST}..."

cat > "$PLIST" << 'PLISTEOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.fleetshell.loopback</string>

    <key>ProgramArguments</key>
    <array>
        <string>/bin/sh</string>
        <string>-c</string>
        <string>
            for i in 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17; do
                /sbin/ifconfig lo0 alias 127.0.0.$i 255.0.0.0 2>/dev/null || true
            done
        </string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>StandardOutPath</key>
    <string>/var/log/com.fleetshell.loopback.log</string>

    <key>StandardErrorPath</key>
    <string>/var/log/com.fleetshell.loopback.log</string>
</dict>
</plist>
PLISTEOF

# ── Correct ownership and permissions (required by launchd) ───────────────────
chown root:wheel "$PLIST"
chmod 644 "$PLIST"

# ── Load it immediately (no reboot needed) ────────────────────────────────────
launchctl bootout system "$PLIST" 2>/dev/null || true
launchctl bootstrap system "$PLIST"

echo ""
echo "Done. Loopback aliases 127.0.0.2 – 127.0.0.17 are now active"
echo "and will be restored automatically at every boot."
echo ""
echo "To verify:"
echo "  ifconfig lo0 | grep '127.0.0'"
