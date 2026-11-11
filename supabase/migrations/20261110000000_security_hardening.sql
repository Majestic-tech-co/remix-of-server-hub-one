-- Security hardening: RLS tightening, cross-tenant ownership checks, input constraints.
-- Safe to re-run (idempotent where possible).

-- 1. Make sure RLS is on for every table (defence in depth; already enabled).
ALTER TABLE public.servers            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.metrics            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commands           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.terminal_sessions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_tasks   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_runs    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_logs          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cost_metrics       ENABLE ROW LEVEL SECURITY;

-- 2. Signed-out (anon) users get NO privileges on any app table.
REVOKE ALL ON public.servers, public.metrics, public.commands, public.terminal_sessions,
              public.automation_tasks, public.automation_runs, public.task_logs, public.cost_metrics
  FROM anon;

-- 3. Ownership checks on child rows: a user may only reference their own parents.
DROP POLICY IF EXISTS "owner all automation_runs" ON public.automation_runs;
CREATE POLICY "owner all automation_runs" ON public.automation_runs
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (SELECT 1 FROM public.automation_tasks t WHERE t.id = task_id AND t.user_id = auth.uid())
  );

DROP POLICY IF EXISTS "owner all task_logs" ON public.task_logs;
CREATE POLICY "owner all task_logs" ON public.task_logs
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (SELECT 1 FROM public.servers s WHERE s.id = server_id AND s.user_id = auth.uid())
    AND EXISTS (SELECT 1 FROM public.automation_runs r WHERE r.id = run_id AND r.user_id = auth.uid())
    AND (command_id IS NULL OR EXISTS (SELECT 1 FROM public.commands c WHERE c.id = command_id AND c.user_id = auth.uid()))
  );

DROP POLICY IF EXISTS "owner all cost_metrics" ON public.cost_metrics;
CREATE POLICY "owner all cost_metrics" ON public.cost_metrics
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (SELECT 1 FROM public.servers s WHERE s.id = server_id AND s.user_id = auth.uid())
  );

-- 4. Server-side input constraints (NOT VALID = enforced for new/updated rows,
--    existing rows are not re-checked so the migration cannot fail on old data).
ALTER TABLE public.servers
  DROP CONSTRAINT IF EXISTS servers_input_limits,
  ADD CONSTRAINT servers_input_limits CHECK (
    char_length(name) BETWEEN 1 AND 100
    AND (hostname IS NULL OR char_length(hostname) <= 255)
    AND (ip_address IS NULL OR char_length(ip_address) <= 64)
    AND (os IS NULL OR char_length(os) <= 255)
    AND (region IS NULL OR char_length(region) <= 64)
    AND (instance_id IS NULL OR char_length(instance_id) <= 64)
    AND (connection_notes IS NULL OR char_length(connection_notes) <= 5000)
    AND coalesce(array_length(tags, 1), 0) <= 20
  ) NOT VALID;

ALTER TABLE public.commands
  DROP CONSTRAINT IF EXISTS commands_input_limits,
  ADD CONSTRAINT commands_input_limits CHECK (char_length(command) BETWEEN 1 AND 20000) NOT VALID;

ALTER TABLE public.automation_tasks
  DROP CONSTRAINT IF EXISTS automation_tasks_input_limits,
  ADD CONSTRAINT automation_tasks_input_limits CHECK (
    char_length(name) BETWEEN 1 AND 100
    AND (description IS NULL OR char_length(description) <= 1000)
    AND char_length(script_content) BETWEEN 1 AND 20000
  ) NOT VALID;

ALTER TABLE public.cost_metrics
  DROP CONSTRAINT IF EXISTS cost_metrics_input_limits,
  ADD CONSTRAINT cost_metrics_input_limits CHECK (daily_cost >= 0 AND daily_cost < 1000000 AND char_length(currency) <= 8) NOT VALID;

ALTER TABLE public.terminal_sessions
  DROP CONSTRAINT IF EXISTS terminal_sessions_input_limits,
  ADD CONSTRAINT terminal_sessions_input_limits CHECK (
    cols BETWEEN 20 AND 500 AND rows BETWEEN 5 AND 200 AND char_length(input_buffer) <= 300000
  ) NOT VALID;
