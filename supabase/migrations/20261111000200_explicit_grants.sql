-- Explicit, least-privilege API grants.
-- Works whether or not "Automatically expose new tables" is enabled in Supabase:
-- it first strips everything the API roles might have received by default, then
-- grants only what the app actually uses. Row-level security still applies on top.
--
--   anon           -> nothing (signed-out visitors can't touch any table)
--   authenticated  -> only what the browser UI does, filtered by RLS
--   service_role   -> everything (server routes: agent API, create/rotate server)
--
-- Run AFTER all earlier migrations. Safe to re-run.

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- 1. Reset
REVOKE ALL ON public.servers, public.metrics, public.commands, public.terminal_sessions,
              public.automation_tasks, public.automation_runs, public.task_logs, public.cost_metrics
  FROM anon, authenticated;

-- 2. Server-side routes (service role) need full access, incl. the metrics id sequence.
GRANT ALL ON public.servers, public.metrics, public.commands, public.terminal_sessions,
             public.automation_tasks, public.automation_runs, public.task_logs, public.cost_metrics
  TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.metrics_id_seq TO service_role;

-- 3. Browser (authenticated) — minimal, matches the UI.
-- servers: read non-secret columns only (agent_token_hash is never readable),
-- edit descriptive fields, delete. Inserts go through /api/servers/create.
GRANT SELECT (id, user_id, name, hostname, ip_address, os, tags, last_seen_at, created_at,
              type, region, instance_id, connection_notes)
  ON public.servers TO authenticated;
GRANT UPDATE (name, tags, type, region, instance_id, connection_notes)
  ON public.servers TO authenticated;
GRANT DELETE ON public.servers TO authenticated;

-- metrics: read-only (written by agents via service role).
GRANT SELECT ON public.metrics TO authenticated;

-- commands: queue and read own commands, delete history. Updates are agent-only.
GRANT SELECT, INSERT, DELETE ON public.commands TO authenticated;

-- terminal_sessions: read-only (e.g. open-session counts). Sessions are created and
-- polled through /api/terminal/* using the service role.
GRANT SELECT ON public.terminal_sessions TO authenticated;

-- playbooks, runs, logs, costs: full CRUD on own rows.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.automation_tasks TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.automation_runs  TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.task_logs        TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cost_metrics     TO authenticated;
