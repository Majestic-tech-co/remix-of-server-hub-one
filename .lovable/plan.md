## Why this approach

You picked "most secure" — that rules out:
- **SSH from backend** — Cloudflare Workers can't open raw TCP. Would need an external relay you host (extra infra, extra attack surface).
- **Per-server web-SSH (wetty)** — needs an open public port + TLS cert on every server. Fragile and exposed.
- **WebSocket Durable Objects** — supported on Workers but adds a new infra concept and the `agent.sh` bash script can't easily speak WebSocket.

What's left and works today: **extend the existing agent with a PTY mode driven by HTTP long-polling.** The agent already polls outbound every 15s — we add fast-poll (≈150ms) only while a terminal session is active. The browser uses xterm.js + Server-Sent Events to feel live.

Security wins: agent stays outbound-only (no inbound ports), no SSH credentials anywhere, RLS gates session ownership, sessions auto-expire on disconnect.

## Architecture

```text
Browser (xterm.js)
    │ keystrokes  POST /api/terminal/$sessionId/input  ──┐
    │                                                     ▼
    │                                         terminal_sessions table
    │                                         (input_buffer, output_buffer)
    │                                                     ▲
    │ output      GET /api/terminal/$sessionId/stream ───┘  (SSE, polls DB ~150ms)
    ▼
Agent (every 200ms while session open)
    GET /api/agent/terminal-poll  → { pending_input, status }
    spawns: python3 -c "import pty; pty.spawn(['/bin/bash','-i'])"
    POST /api/agent/terminal-output  ← PTY stdout chunks
```

## What gets built

### 1. Database — new `terminal_sessions` table
- `id`, `server_id`, `user_id`, `status` (`requested` | `active` | `closed`)
- `input_buffer` text, `output_buffer` text, `last_input_seq`, `last_output_seq` (so agent and browser ack what they've consumed)
- `cols`, `rows` for window size
- `created_at`, `closed_at`
- RLS: owner can SELECT/INSERT/UPDATE-status-only; agent (service role) reads/writes everything for sessions belonging to its server

### 2. Backend routes (TanStack server routes)
**Browser side** (auth via Supabase session, RLS):
- `POST /api/terminal/start` → creates session row, returns `session_id`
- `POST /api/terminal/$id/input` → appends bytes to `input_buffer`, increments seq
- `GET /api/terminal/$id/stream` → SSE stream; polls `output_buffer` every 150ms, pushes new bytes
- `POST /api/terminal/$id/resize` → updates cols/rows
- `POST /api/terminal/$id/close` → marks closed

**Agent side** (auth via `X-Fleet-Token`, service role):
- `GET /api/agent/terminal-poll` → returns active sessions for this server + their pending input bytes since last ack
- `POST /api/agent/terminal-output` → appends PTY output bytes to a session's `output_buffer`

### 3. Agent (`src/agent/install.sh`) — new PTY mode
Add a Python helper alongside the bash agent (Python3 ships on every modern distro — no extra install):
- A second loop polls `/api/agent/terminal-poll` every 200ms
- For each new active session, fork a Python child that runs `pty.spawn(['/bin/bash','-i'])` with TERM=xterm-256color
- Child writes received input bytes to PTY master fd, reads PTY output and POSTs to `/api/agent/terminal-output` in chunks
- Honors `cols`/`rows` via `TIOCSWINSZ` ioctl
- On `closed` status or 60s of no browser activity → SIGHUP the bash process and clean up

### 4. Frontend — replace command list with xterm.js
- `bun add @xterm/xterm @xterm/addon-fit @xterm/addon-web-links`
- New `<Terminal serverId={...} />` component:
  - Mounts `xterm.js`, calls `/api/terminal/start`, opens SSE to `/stream`
  - `term.onData(bytes => fetch('/input', {body: bytes}))` — typing flows up
  - SSE messages → `term.write(bytes)` — output flows down
  - `ResizeObserver` → `fitAddon.fit()` → POST `/resize`
  - On unmount → POST `/close`
- **Remove the queued-command UI** (you asked for it gone): delete preset buttons, history, danger-confirm, `commands` table polling. The `commands` table itself stays for now (cheap to leave) but nothing reads/writes it from the UI.

### 5. Cleanup
- Drop the `useEffect` that polls `commands`
- Remove `Terminal` (the fake one) and `cmdDuration` helper
- Keep `/api/agent/command-result` and `/api/agent/command-output` as-is for now (no longer hit by anything but harmless); the agent's command-execution loop in `install.sh` gets removed in favor of the new PTY loop

## Security model

- Browser-facing routes: Supabase auth required; RLS confirms `session.server_id` belongs to `auth.uid()` before any read/write
- Agent routes: `X-Fleet-Token` header matches `servers.agent_token` (same model already used)
- Session input/output buffers are wiped on close and have a hard 1MB rolling cap
- Sessions auto-close after 5 min of no browser polling (cron-free: checked lazily on each poll)
- New security memory entry: "terminal_sessions buffers contain raw shell I/O — RLS limits to owner; agent writes are service-role only"

## Tradeoffs you should know

- **Latency**: ~150–300ms typing-to-echo (DB-mediated). Real SSH feels ~20ms. Acceptable for admin work; not great for vim power-users. If this becomes painful later, we swap the transport for Durable Object WebSockets without touching the UI.
- **Throughput**: capped at ~50KB/s per session (DB writes every 200ms × ~10KB chunks). Fine for shells, slow for `cat largefile`.
- **Re-install required**: every server needs the new agent (`curl ... | sudo bash` again).

## What I will NOT change

- Metrics collection (works as-is)
- Server list, charts, server detail layout
- Auth, RLS on `servers`/`metrics`
- The agent token rotation guard

## Implementation order

1. DB migration (`terminal_sessions` + RLS)
2. Backend routes (browser + agent)
3. Agent PTY loop in `install.sh`
4. Frontend xterm.js component, drop the old terminal UI
5. Update security memory

Approve and I'll ship it.