#!/usr/bin/env bash
# Fleet agent installer
set -euo pipefail

if [ "${EUID:-$(id -u)}" -ne 0 ]; then
  echo "Run as root (use sudo)." >&2
  exit 1
fi

: "${FLEET_TOKEN:?FLEET_TOKEN env var required}"
: "${FLEET_URL:?FLEET_URL env var required}"

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

  mt_kb=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
  ma_kb=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)
  mem_total=$(awk -v k="$mt_kb" 'BEGIN{printf "%.1f",k/1024}')
  mem_used=$(awk -v t="$mt_kb" -v a="$ma_kb" 'BEGIN{printf "%.1f",(t-a)/1024}')
  mem_pct=$(awk -v t="$mt_kb" -v a="$ma_kb" 'BEGIN{printf "%.1f",((t-a)/t)*100}')

  read -r _ size used _ pct _ <<<"$(df -BG --output=source,size,used,avail,pcent,target / | tail -1)"
  disk_total=${size%G}
  disk_used=${used%G}
  disk_pct=${pct%\%}

  load1=$(awk '{print $1}' /proc/loadavg)
  uptime=$(awk '{print int($1)}' /proc/uptime)

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

RUNNING_DIR=/var/lib/fleet-agent/running
mkdir -p "$RUNNING_DIR"
# Hard cap: how long a single command may run before SIGTERM
CMD_TIMEOUT="${CMD_TIMEOUT:-1800}"   # 30 min default
# Max concurrent commands
CMD_MAX_CONCURRENT="${CMD_MAX_CONCURRENT:-2}"

post_result() {
  local cmd_id="$1" code="$2" out_file="$3" err_file="$4"
  local out err
  out=$(head -c 200000 "$out_file" 2>/dev/null || echo "")
  err=$(head -c 200000 "$err_file" 2>/dev/null || echo "")
  payload=$(jq -n --arg id "$cmd_id" --argjson code "$code" --arg out "$out" --arg err "$err" \
    '{command_id:$id, exit_code:$code, stdout:$out, stderr:$err}')
  # Retry the result POST a few times so a transient network blip doesn't
  # leave a command stuck in "running" forever.
  for attempt in 1 2 3 4 5; do
    if curl -fsS --max-time 30 -X POST "$FLEET_URL/api/agent/command-result" \
        -H "Content-Type: application/json" \
        -H "X-Fleet-Token: $FLEET_TOKEN" \
        -d "$payload" >/dev/null; then
      break
    fi
    sleep $((attempt * 2))
  done
}

run_command_async() {
  local cmd_id="$1" cmd="$2"
  local marker="$RUNNING_DIR/$cmd_id"
  # Skip if already running (idempotency — same command may be re-issued)
  [ -e "$marker" ] && return 0
  : > "$marker"

  (
    out_file=$(mktemp); err_file=$(mktemp)
    # - </dev/null: no stdin so prompts don't hang forever
    # - setsid + new process group so we can clean up child trees
    # - timeout: hard cap to protect the box from runaway jobs
    # - DEBIAN_FRONTEND=noninteractive: avoid apt prompts by default
    DEBIAN_FRONTEND=noninteractive setsid timeout --signal=TERM --kill-after=30 "$CMD_TIMEOUT" \
      bash -c "$cmd" </dev/null >"$out_file" 2>"$err_file"
    code=$?
    if [ "$code" -eq 124 ]; then
      echo "[fleet-agent] command exceeded ${CMD_TIMEOUT}s timeout, terminated" >> "$err_file"
    fi
    post_result "$cmd_id" "$code" "$out_file" "$err_file"
    rm -f "$out_file" "$err_file" "$marker"
  ) &
  disown || true
}

reap_stale() {
  # Remove markers whose child died without cleanup (e.g. agent restart)
  find "$RUNNING_DIR" -type f -mmin +60 -delete 2>/dev/null || true
}

while true; do
  reap_stale
  body=$(read_metrics)
  resp=$(curl -fsS --max-time 20 -X POST "$FLEET_URL/api/agent/metrics" \
    -H "Content-Type: application/json" \
    -H "X-Fleet-Token: $FLEET_TOKEN" \
    -d "$body" 2>/dev/null || echo '{}')

  # Respect concurrency cap
  while IFS= read -r row; do
    [ -z "$row" ] && continue
    running=$(find "$RUNNING_DIR" -type f 2>/dev/null | wc -l)
    if [ "$running" -ge "$CMD_MAX_CONCURRENT" ]; then break; fi
    id=$(echo "$row" | jq -r '.id')
    cmd=$(echo "$row" | jq -r '.command')
    [ -n "$id" ] && [ "$id" != "null" ] && run_command_async "$id" "$cmd"
  done < <(echo "$resp" | jq -c '.pending_commands[]?' 2>/dev/null)

  sleep 15
done
AGENT
chmod +x "$INSTALL_DIR/agent.sh"

cat > /etc/fleet-agent.conf <<EOF
FLEET_URL="$FLEET_URL"
FLEET_TOKEN="$FLEET_TOKEN"
EOF
chmod 600 /etc/fleet-agent.conf

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
