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

# ----- Metrics agent (bash) ---------------------------------------------------
cat > "$INSTALL_DIR/agent.sh" <<'AGENT'
#!/usr/bin/env bash
# Fleet metrics agent — pings every 60s.
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

# ---- API helpers (token comes from the root-only curl config, never from argv) ----
api_post() {
  # $1 = path (may include query). JSON body is read from stdin: a command-line argument
  # is capped at ~128KB and would also be visible to other users in ps.
  curl -fsS --max-time 30 -X POST -K /etc/fleet-agent.curl "$FLEET_URL/api/agent/$1" --data-binary @- 2>/dev/null
}

JOBS_DIR=/var/lib/fleet-agent/jobs
MAX_JOBS=5
MAX_OUT=150000      # bytes of stdout / stderr kept per command
CMD_TIMEOUT=1800    # seconds before a command is killed
mkdir -p "$JOBS_DIR"; chmod 700 "$JOBS_DIR"

# Keep the last MAX_OUT bytes of a file, NUL bytes removed (Postgres text cannot hold them).
# Output goes through files (jq --rawfile), not arguments: a single argument is capped at ~128KB.
prep_output() { tail -c "$MAX_OUT" "$1" 2>/dev/null | tr -d '\000' > "$2"; }

post_output() {
  # $1 = command id, $2 = job dir
  local payload
  prep_output "$2/out" "$2/out.t"; prep_output "$2/err" "$2/err.t"
  payload=$(jq -n --arg id "$1" --rawfile so "$2/out.t" --rawfile se "$2/err.t"     '{command_id:$id, stdout:$so, stderr:$se}') || return 0
  printf '%s' "$payload" | api_post command-output >/dev/null || true
}

post_result() {
  # $1 = command id, $2 = exit code, $3 = job dir
  local payload
  prep_output "$3/out" "$3/out.t"; prep_output "$3/err" "$3/err.t"
  payload=$(jq -n --arg id "$1" --argjson code "$2" --rawfile so "$3/out.t" --rawfile se "$3/err.t"     '{command_id:$id, exit_code:$code, stdout:$so, stderr:$se}') || return 0
  # retry a few times so a brief network blip does not lose the result
  local n
  for n in 1 2 3 4 5; do
    printf '%s' "$payload" | api_post command-result >/dev/null && return 0
    sleep 3
  done
}

run_command() {
  # $1 = command id, $2 = command text. Runs in the background.
  local id="$1" cmd="$2" dir pid code
  dir=$(mktemp -d "$JOBS_DIR/job.XXXXXX") || return
  printf '%s\n' "$cmd" > "$dir/script.sh"
  : > "$dir/out"; : > "$dir/err"
  ( cd / && HOME=/root timeout "$CMD_TIMEOUT" /bin/bash "$dir/script.sh" >"$dir/out" 2>"$dir/err" </dev/null; echo $? > "$dir/code" ) &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    sleep 3
    post_output "$id" "$dir"      # live progress for the UI
  done
  wait "$pid" 2>/dev/null
  code=$(cat "$dir/code" 2>/dev/null || echo 1)
  case "$code" in ''|*[!0-9]*) code=1 ;; esac
  post_result "$id" "$code" "$dir"
  rm -rf "$dir"
}

handle_commands() {
  # $1 = JSON response from the server
  local line id cmd
  [ -n "$1" ] || return 0
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    id=$(jq -r '.id // empty' <<<"$line")
    cmd=$(jq -r '.command // empty' <<<"$line")
    [ -n "$id" ] && [ -n "$cmd" ] || continue
    run_command "$id" "$cmd" &
  done < <(jq -c '.pending_commands[]?' <<<"$1" 2>/dev/null)
}

LAST_METRICS=0
while true; do
  now=$(date +%s)
  running=$(jobs -rp | wc -l)
  resp=""
  if [ $((now - LAST_METRICS)) -ge 60 ]; then
    # full report (also returns any pending commands)
    resp=$(read_metrics | api_post metrics) || resp=""
    LAST_METRICS=$(date +%s)
  elif [ "$running" -lt "$MAX_JOBS" ]; then
    # lightweight check for queued commands
    resp=$(printf '{}' | api_post "metrics?commands_only=1") || resp=""
  fi
  handle_commands "$resp"
  sleep 5
done
AGENT
chmod +x "$INSTALL_DIR/agent.sh"

# ----- Terminal agent (Python PTY) -------------------------------------------
cat > "$INSTALL_DIR/terminal.py" <<'PYAGENT'
#!/usr/bin/env python3
# Fleet terminal agent.
# Long-polls /api/agent/terminal every ~250ms, spawning a real PTY-backed
# bash for each active session. Bytes from PTY -> server (output queue),
# bytes from server -> PTY stdin (input buffer).

import base64, fcntl, json, os, pty, select, signal, struct, sys, termios, time, traceback
from http.client import HTTPConnection, HTTPSConnection
from urllib.parse import urlparse

CFG = "/etc/fleet-agent.conf"
cfg = {}
with open(CFG) as f:
    for line in f:
        line = line.strip()
        if not line or line.startswith("#"): continue
        if "=" in line:
            k, v = line.split("=", 1)
            cfg[k.strip()] = v.strip().strip('"').strip("'")

FLEET_URL = cfg["FLEET_URL"]
FLEET_TOKEN = cfg["FLEET_TOKEN"]

POLL_INTERVAL_ACTIVE = 0.05   # 50ms between polls while a session is open (cut short when the shell prints)
POLL_INTERVAL_QUIET = 0.25    # relaxed rate while a session is open but nothing is happening
QUIET_AFTER = 3.0             # seconds without input/output before relaxing
POLL_INTERVAL_IDLE = 2.0      # 2s when nothing's open
last_activity = time.time()
OUTPUT_FLUSH_BYTES = 8192
OUTPUT_FLUSH_MS = 25      # send shell output almost immediately so typing feels live

_conn = None

def _connect():
    u = urlparse(FLEET_URL)
    conn_cls = HTTPSConnection if u.scheme == "https" else HTTPConnection
    return conn_cls(u.hostname, u.port or (443 if u.scheme == "https" else 80), timeout=20)

def post_json(path, body):
    # Reuse ONE long-lived connection. Opening a new TCP+TLS connection for every poll used to cost
    # about half of each poll's latency. If the connection has gone stale, reconnect once and retry.
    global _conn
    u = urlparse(FLEET_URL + path)
    payload = json.dumps(body).encode()
    headers = {"Content-Type": "application/json", "X-Fleet-Token": FLEET_TOKEN}
    for attempt in (1, 2):
        if _conn is None:
            _conn = _connect()
        try:
            _conn.request("POST", u.path or "/", payload, headers)
            r = _conn.getresponse()
            data = r.read()
            break
        except Exception:
            try:
                _conn.close()
            except Exception:
                pass
            _conn = None
            if attempt == 2:
                raise
    if r.status >= 400:
        raise RuntimeError(f"{r.status} {data[:200]!r}")
    return json.loads(data) if data else {}

# Per-session state
class Session:
    def __init__(self, sid, cols, rows):
        self.sid = sid
        self.cols = cols
        self.rows = rows
        self.pid = None
        self.fd = None
        self.out_buf = bytearray()
        self.last_flush = time.time()
        self.input_consumed_bytes = 0  # bytes acked back to server
        self.spawn(cols, rows)

    def spawn(self, cols, rows):
        env = os.environ.copy()
        env["TERM"] = "xterm-256color"
        env["LANG"] = env.get("LANG", "C.UTF-8")
        env["PS1"] = r"\u@\h:\w\$ "
        pid, fd = pty.fork()
        if pid == 0:
            # Child
            try:
                os.execvpe("/bin/bash", ["/bin/bash", "-il"], env)
            except Exception:
                os.execvpe("/bin/sh", ["/bin/sh", "-i"], env)
        self.pid = pid
        self.fd = fd
        self.set_size(cols, rows)
        # non-blocking
        flags = fcntl.fcntl(fd, fcntl.F_GETFL)
        fcntl.fcntl(fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)

    def set_size(self, cols, rows):
        try:
            fcntl.ioctl(self.fd, termios.TIOCSWINSZ,
                        struct.pack("HHHH", rows, cols, 0, 0))
            self.cols, self.rows = cols, rows
        except Exception:
            pass

    def write_input(self, data: bytes):
        if not data: return
        try:
            os.write(self.fd, data)
        except (OSError, BrokenPipeError):
            pass

    def read_output(self):
        try:
            chunk = os.read(self.fd, 65536)
            if chunk:
                self.out_buf.extend(chunk)
        except BlockingIOError:
            pass
        except OSError:
            return False  # PTY closed
        return True

    def alive(self):
        if self.pid is None: return False
        try:
            pid, _ = os.waitpid(self.pid, os.WNOHANG)
            return pid == 0
        except ChildProcessError:
            return False

    def close(self):
        try:
            if self.fd is not None:
                os.close(self.fd)
        except OSError:
            pass
        try:
            if self.pid:
                os.kill(self.pid, signal.SIGHUP)
        except ProcessLookupError:
            pass
        self.fd = None
        self.pid = None

sessions: dict[str, Session] = {}

def main():
    print("[fleet-terminal] starting", flush=True)
    while True:
        try:
            tick()
        except Exception as e:
            print(f"[fleet-terminal] error: {e}", file=sys.stderr, flush=True)
            traceback.print_exc()
            time.sleep(2)

def tick():
    global last_activity
    # 1. Read PTY output for every alive session
    outputs = []
    dead = []
    for sid, s in sessions.items():
        if not s.read_output() or not s.alive():
            dead.append(sid)
        if s.out_buf and (len(s.out_buf) >= OUTPUT_FLUSH_BYTES or
                          (time.time() - s.last_flush) * 1000 >= OUTPUT_FLUSH_MS):
            b64 = base64.b64encode(bytes(s.out_buf)).decode()
            outputs.append({"session_id": sid, "b64": b64})
            s.out_buf.clear()
            s.last_flush = time.time()

    if outputs:
        last_activity = time.time()

    # 2. Build acks for input consumed last round
    acks = {sid: s.input_consumed_bytes for sid, s in sessions.items() if s.input_consumed_bytes > 0}
    for sid in acks: sessions[sid].input_consumed_bytes = 0

    # 3. Poll the server
    body = {}
    if acks: body["acks"] = acks
    if outputs: body["outputs"] = outputs

    try:
        resp = post_json("/api/agent/terminal", body)
    except Exception as e:
        print(f"[fleet-terminal] poll failed: {e}", file=sys.stderr, flush=True)
        time.sleep(POLL_INTERVAL_IDLE)
        return

    server_sessions = {s["id"]: s for s in resp.get("sessions", [])}

    # 4. Spawn / update / close to match server view
    for sid, info in server_sessions.items():
        if info["status"] == "closed":
            if sid in sessions:
                sessions[sid].close()
                del sessions[sid]
            continue
        if sid not in sessions:
            try:
                sessions[sid] = Session(sid, info["cols"], info["rows"])
                print(f"[fleet-terminal] spawned session {sid[:8]} ({info['cols']}x{info['rows']})", flush=True)
            except Exception as e:
                print(f"[fleet-terminal] spawn failed: {e}", file=sys.stderr, flush=True)
                continue
        s = sessions[sid]
        if info["cols"] != s.cols or info["rows"] != s.rows:
            s.set_size(info["cols"], info["rows"])

        # Forward input bytes
        ib64 = info.get("input_b64") or ""
        if ib64:
            try:
                # one base64 chunk per line: decode each separately (padding in the middle of a
                # concatenated string makes b64decode silently drop everything after the first chunk)
                raw = b"".join(base64.b64decode(p) for p in ib64.split("\n") if p)
                s.write_input(raw)
                last_activity = time.time()
                s.input_consumed_bytes = len(ib64)  # ack the base64 chars
            except Exception:
                s.input_consumed_bytes = len(ib64)  # don't loop on bad input

    # 5. Reap any dead PTYs
    for sid in dead:
        if sid in sessions:
            sessions[sid].close()
            del sessions[sid]
            print(f"[fleet-terminal] session {sid[:8]} died", flush=True)

    if sessions:
        # wait for the shell to print (wakes instantly) instead of sleeping a fixed time
        fds = [x.fd for x in sessions.values() if x.fd is not None]
        try:
            quiet = time.time() - last_activity > QUIET_AFTER
            select.select(fds, [], [], POLL_INTERVAL_QUIET if quiet else POLL_INTERVAL_ACTIVE)
        except (OSError, ValueError):
            time.sleep(POLL_INTERVAL_ACTIVE)
    else:
        time.sleep(POLL_INTERVAL_IDLE)

if __name__ == "__main__":
    main()
PYAGENT
chmod +x "$INSTALL_DIR/terminal.py"

# Create secret files private from the first byte (no window where they are world-readable).
umask 077
cat > /etc/fleet-agent.conf <<EOF
FLEET_URL="$FLEET_URL"
FLEET_TOKEN="$FLEET_TOKEN"
EOF
cat > /etc/fleet-agent.curl <<EOF
header = "Content-Type: application/json"
header = "X-Fleet-Token: $FLEET_TOKEN"
EOF
chmod 600 /etc/fleet-agent.conf /etc/fleet-agent.curl
umask 022

# Install dependencies
if ! command -v jq >/dev/null 2>&1 || ! command -v python3 >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get update -y >/dev/null 2>&1 || true
    DEBIAN_FRONTEND=noninteractive apt-get install -y jq curl python3 >/dev/null 2>&1 || true
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y jq curl python3 >/dev/null 2>&1 || true
  elif command -v yum >/dev/null 2>&1; then
    yum install -y jq curl python3 >/dev/null 2>&1 || true
  fi
fi

cat > /etc/systemd/system/fleet-agent.service <<EOF
[Unit]
Description=Fleet metrics agent
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

cat > /etc/systemd/system/fleet-terminal.service <<EOF
[Unit]
Description=Fleet terminal agent (PTY)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/python3 /opt/fleet-agent/terminal.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now fleet-agent.service
systemctl enable --now fleet-terminal.service

echo ""
echo "✓ Fleet agent + terminal installed and running."
echo "  Logs: journalctl -u fleet-agent -f"
echo "        journalctl -u fleet-terminal -f"
