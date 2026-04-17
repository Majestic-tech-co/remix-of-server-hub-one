// GET /api/agent/install — returns the install bash script (curl-pipe-bash style)
import { createFileRoute } from "@tanstack/react-router";

const SCRIPT = `#!/usr/bin/env bash
# Fleet agent installer
set -euo pipefail

if [ "\${EUID:-$(id -u)}" -ne 0 ]; then
  echo "Run as root (use sudo)." >&2
  exit 1
fi

: "\${FLEET_TOKEN:?FLEET_TOKEN env var required}"
: "\${FLEET_URL:?FLEET_URL env var required}"

INSTALL_DIR=/opt/fleet-agent
mkdir -p "$INSTALL_DIR"

cat > "$INSTALL_DIR/agent.sh" <<'AGENT'
#!/usr/bin/env bash
# Fleet agent — pings every 60s, runs queued commands.
set -uo pipefail

CFG=/etc/fleet-agent.conf
. "$CFG"

NET_PREV_FILE=/var/lib/fleet-agent/net_prev
mkdir -p /var/lib/fleet-agent

read_metrics() {
  local hostname ip os cpu mem_pct mem_used mem_total disk_pct disk_used disk_total load1 uptime rx_kbs tx_kbs

  hostname="$(hostname -f 2>/dev/null || hostname)"
  ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  if [ -r /etc/os-release ]; then
    os="$(. /etc/os-release; echo "${PRETTY_NAME:-$NAME}")"
  else
    os="$(uname -s)"
  fi

  # CPU: average over 1s using /proc/stat
  read -r _ a b c d e f g _ < /proc/stat
  total1=$((a+b+c+d+e+f+g)); idle1=$d
  sleep 1
  read -r _ a b c d e f g _ < /proc/stat
  total2=$((a+b+c+d+e+f+g)); idle2=$d
  dt=$((total2-total1)); di=$((idle2-idle1))
  if [ "$dt" -gt 0 ]; then
    cpu=$(awk -v dt="$dt" -v di="$di" 'BEGIN{printf "%.1f",(1-di/dt)*100}')
  else
    cpu="0"
  fi

  # Memory from /proc/meminfo (kB)
  mt_kb=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
  ma_kb=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)
  mem_total=$(awk -v k="$mt_kb" 'BEGIN{printf "%.1f",k/1024}')
  mem_used=$(awk -v t="$mt_kb" -v a="$ma_kb" 'BEGIN{printf "%.1f",(t-a)/1024}')
  mem_pct=$(awk -v t="$mt_kb" -v a="$ma_kb" 'BEGIN{printf "%.1f",((t-a)/t)*100}')

  # Disk for /
  read -r _ size used _ pct _ <<<"$(df -BG --output=source,size,used,avail,pcent,target / | tail -1)"
  disk_total=${size%G}
  disk_used=${used%G}
  disk_pct=${pct%\\%}

  # Load
  load1=$(awk '{print $1}' /proc/loadavg)
  uptime=$(awk '{print int($1)}' /proc/uptime)

  # Network: sum rx/tx bytes across non-lo interfaces
  rx_now=0; tx_now=0
  while IFS= read -r line; do
    iface=$(echo "$line" | awk -F: '{print $1}' | tr -d ' ')
    [ "$iface" = "lo" ] && continue
    [ -z "$iface" ] && continue
    nums=$(echo "$line" | awk -F: '{print $2}')
    set -- $nums
    rx_now=$((rx_now + $1))
    tx_now=$((tx_now + $9))
  done < <(tail -n +3 /proc/net/dev)

  rx_kbs=0; tx_kbs=0
  if [ -f "$NET_PREV_FILE" ]; then
    read -r prev_rx prev_tx prev_t < "$NET_PREV_FILE" || true
    now_t=$(date +%s)
    dt2=$((now_t - prev_t))
    if [ "$dt2" -gt 0 ]; then
      rx_kbs=$(awk -v a="$rx_now" -v b="$prev_rx" -v dt="$dt2" 'BEGIN{printf "%.1f",((a-b)/1024)/dt}')
      tx_kbs=$(awk -v a="$tx_now" -v b="$prev_tx" -v dt="$dt2" 'BEGIN{printf "%.1f",((a-b)/1024)/dt}')
    fi
  fi
  echo "$rx_now $tx_now $(date +%s)" > "$NET_PREV_FILE"

  cat <<JSON
{
  "hostname": "$hostname",
  "ip": "$ip",
  "os": "$os",
  "cpu_percent": $cpu,
  "memory_percent": $mem_pct,
  "memory_used_mb": $mem_used,
  "memory_total_mb": $mem_total,
  "disk_percent": $disk_pct,
  "disk_used_gb": $disk_used,
  "disk_total_gb": $disk_total,
  "net_rx_kbs": $rx_kbs,
  "net_tx_kbs": $tx_kbs,
  "load_1": $load1,
  "uptime_seconds": $uptime
}
JSON
}

run_command() {
  local cmd_id="$1" cmd="$2"
  local out err code
  out_file=$(mktemp); err_file=$(mktemp)
  bash -c "$cmd" >"$out_file" 2>"$err_file"
  code=$?
  out=$(head -c 200000 "$out_file")
  err=$(head -c 200000 "$err_file")
  rm -f "$out_file" "$err_file"
  # Build JSON safely with jq if available, else manual escape
  if command -v jq >/dev/null 2>&1; then
    payload=$(jq -n --arg id "$cmd_id" --argjson code "$code" --arg out "$out" --arg err "$err" \
      '{command_id:$id, exit_code:$code, stdout:$out, stderr:$err}')
  else
    esc() { python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))' <<<"$1" 2>/dev/null \
      || printf '"%s"' "$(printf %s "$1" | sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g' -e ':a;N;$!ba;s/\\n/\\\\n/g')"; }
    payload="{\\"command_id\\":\\"$cmd_id\\",\\"exit_code\\":$code,\\"stdout\\":$(esc "$out"),\\"stderr\\":$(esc "$err")}"
  fi
  curl -fsS -X POST "$FLEET_URL/api/agent/command-result" \
    -H "Content-Type: application/json" \
    -H "X-Fleet-Token: $FLEET_TOKEN" \
    -d "$payload" >/dev/null || true
}

while true; do
  body=$(read_metrics)
  resp=$(curl -fsS -X POST "$FLEET_URL/api/agent/metrics" \
    -H "Content-Type: application/json" \
    -H "X-Fleet-Token: $FLEET_TOKEN" \
    -d "$body" || echo '{}')

  # Parse pending_commands array
  if command -v jq >/dev/null 2>&1; then
    echo "$resp" | jq -c '.pending_commands[]?' 2>/dev/null | while read -r row; do
      id=$(echo "$row" | jq -r '.id')
      cmd=$(echo "$row" | jq -r '.command')
      [ -n "$id" ] && run_command "$id" "$cmd"
    done
  fi

  sleep 60
done
AGENT
chmod +x "$INSTALL_DIR/agent.sh"

cat > /etc/fleet-agent.conf <<EOF
FLEET_URL="$FLEET_URL"
FLEET_TOKEN="$FLEET_TOKEN"
EOF
chmod 600 /etc/fleet-agent.conf

# Install jq if missing (best effort)
if ! command -v jq >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get update -y >/dev/null 2>&1 || true
    DEBIAN_FRONTEND=noninteractive apt-get install -y jq curl >/dev/null 2>&1 || true
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y jq curl >/dev/null 2>&1 || true
  elif command -v yum >/dev/null 2>&1; then
    yum install -y jq curl >/dev/null 2>&1 || true
  fi
fi

cat > /etc/systemd/system/fleet-agent.service <<EOF
[Unit]
Description=Fleet agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/opt/fleet-agent/agent.sh
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now fleet-agent.service

echo ""
echo "✓ Fleet agent installed and running."
echo "  Logs: journalctl -u fleet-agent -f"
`;

export const Route = createFileRoute("/api/agent/install")({
  server: {
    handlers: {
      GET: async () => {
        return new Response(SCRIPT, {
          status: 200,
          headers: {
            "Content-Type": "text/x-shellscript; charset=utf-8",
            "Cache-Control": "no-store",
          },
        });
      },
    },
  },
});
