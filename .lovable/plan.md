
# Fleet v2 — Sidebar, Automation, Cost Tracker

Adds three new top-level views on top of the existing real agent system, without breaking real metrics, real terminal, or real command execution.

## What changes

### Navigation
Replace the current top-bar shell with a collapsible sidebar (shadcn `Sidebar`) containing four sections:
- **Overview** — new dashboard
- **Servers** — current Fleet page, redesigned as a categorized list (AWS vs Local) with tags, status dot, IP, OS, region
- **Automation** — new
- **Costs** — new

### Overview dashboard
Real aggregates pulled from existing tables:
- Total servers, online / offline counts
- Active terminal sessions (count of `terminal_sessions` updated in last 60s)
- Real-time alert list (any server with CPU > 90% or RAM > 90% in latest metric)
- Estimated month-to-date AWS spend (sum from `cost_metrics`, mock-seeded)

### Server Manager redesign
- Group cards by `type` (AWS / Local), collapsible groups
- Show IP, OS, region (AWS only), tags
- Existing detail page (`/servers/$id`) stays — already has terminal + charts. Add a tab bar at the top: **Terminal**, **Metrics**, **Info**

### Automation Center
- List of `automation_tasks` (Playbooks) with pre-seeded templates: "Update Packages (apt)", "Restart Nginx", "Disk Cleanup", "Show Uptime"
- "Run Playbook" flow: pick task → multi-select servers → confirm → enqueues one row in `commands` per server with the task's script (real execution via existing agent)
- Real-time log console: subscribes to `commands` rows for the run, streams `output` as the agent reports back; per-server success/fail badges
- "New Playbook" dialog: name, description, script content

### Cloud Cost Tracker
- Bar chart: month-to-date spend per AWS server (from `cost_metrics`)
- Daily cost trend (last 30 days) line chart
- "Cost Anomalies" panel: servers where today's daily_cost > 1.5× their 7-day average
- "Underutilized" panel: AWS servers whose avg CPU < 10% for last 24h (real from `metrics`) — actionable since it's real telemetry
- Seed mock cost rows only when user has AWS-type servers; never auto-create fake servers

## Database changes

One migration:
```text
ALTER servers
  ADD type text NOT NULL DEFAULT 'local' CHECK (type IN ('aws','local'))
  ADD region text
  ADD instance_id text
  ADD tags text[] NOT NULL DEFAULT '{}'

CREATE automation_tasks (user_id, name, description, script_content)
  RLS: owner-only
CREATE automation_runs (user_id, task_id, started_at, status)
CREATE task_logs (run_id, server_id, command_id FK, status, output_log)
  RLS: owner-only via run_id → user_id
CREATE cost_metrics (user_id, server_id, day date, daily_cost numeric, currency)
  RLS: owner-only
  unique(server_id, day)
```
Plus GRANTs to `authenticated` + `service_role` on each.

A second migration seeds 4 template playbooks per-user via a trigger on first `servers` insert — or simpler: surface a "Load default playbooks" button on first Automation visit that inserts them for the current user. Going with the button (less magic).

## Mock cost data

Daily cron-style backfill is overkill. Instead, when a user marks a server as `type='aws'`, an "Estimate costs (demo)" button on that server seeds the last 30 days of `cost_metrics` with realistic values based on instance_id (t3.micro ≈ $0.30/day, m5.large ≈ $2.30/day, etc.). User-triggered, clearly labeled "Demo data".

## Files

New:
- `src/components/AppSidebar.tsx`
- `src/routes/_authenticated/overview.tsx` (and move existing index to a layout)
- `src/routes/_authenticated/automation.tsx`
- `src/routes/_authenticated/automation.$runId.tsx` (live log view)
- `src/routes/_authenticated/costs.tsx`
- `src/lib/automation.functions.ts` — create task, run task on N servers, fetch run status
- `src/lib/costs.functions.ts` — seed demo costs, fetch aggregates

Modified:
- `src/components/AppShell.tsx` → sidebar layout
- `src/routes/index.tsx` → redirect to `/overview`
- `src/routes/servers.$id.tsx` → tab bar
- Server create dialog → add type/region/instance_id/tags fields

## Non-goals

- No real AWS Cost Explorer wiring (deferred until you add AWS keys)
- No mock seeded servers — real fleet only
- No simulated terminal — real PTY stays

## Order of work

1. Migration (schema + RLS + GRANTs) — needs your approval first
2. Sidebar shell + route restructure
3. Server type/tag fields in create dialog + grouped list
4. Overview page (real aggregates)
5. Automation: tasks CRUD, run flow, live log view
6. Costs: demo seed button + charts + anomaly panels
