#!/usr/bin/env bash
# Fleet agent uninstaller. Removes exactly what install.sh created, nothing else.
set -euo pipefail

if [ "${EUID:-$(id -u)}" -ne 0 ]; then
  echo "Run as root (use sudo)." >&2
  exit 1
fi

echo "Removing Fleet agent..."

if command -v systemctl >/dev/null 2>&1; then
  for unit in fleet-agent.service fleet-terminal.service; do
    systemctl disable --now "$unit" >/dev/null 2>&1 || true
    rm -f "/etc/systemd/system/$unit"
  done
  systemctl daemon-reload || true
fi

# Fixed paths only (no variables) so this can never delete anything unexpected.
rm -rf /opt/fleet-agent
rm -rf /var/lib/fleet-agent
rm -f /etc/fleet-agent.conf /etc/fleet-agent.curl

echo ""
echo "✓ Fleet agent removed."
echo "  The server will show as offline in the dashboard; you can delete it there."
