
-- 1. Extend servers
ALTER TABLE public.servers
  ADD COLUMN IF NOT EXISTS type text NOT NULL DEFAULT 'local',
  ADD COLUMN IF NOT EXISTS region text,
  ADD COLUMN IF NOT EXISTS instance_id text;

ALTER TABLE public.servers
  DROP CONSTRAINT IF EXISTS servers_type_check;
ALTER TABLE public.servers
  ADD CONSTRAINT servers_type_check CHECK (type IN ('aws','local'));

-- 2. automation_tasks (Playbooks)
CREATE TABLE IF NOT EXISTS public.automation_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  script_content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.automation_tasks TO authenticated;
GRANT ALL ON public.automation_tasks TO service_role;
ALTER TABLE public.automation_tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner all automation_tasks" ON public.automation_tasks
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- 3. automation_runs
CREATE TABLE IF NOT EXISTS public.automation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES public.automation_tasks(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'running',
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.automation_runs TO authenticated;
GRANT ALL ON public.automation_runs TO service_role;
ALTER TABLE public.automation_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner all automation_runs" ON public.automation_runs
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX IF NOT EXISTS automation_runs_user_idx ON public.automation_runs(user_id, started_at DESC);

-- 4. task_logs (one row per server per run, linked to the real command row)
CREATE TABLE IF NOT EXISTS public.task_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES public.automation_runs(id) ON DELETE CASCADE,
  server_id uuid NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
  command_id uuid REFERENCES public.commands(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending',
  output_log text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.task_logs TO authenticated;
GRANT ALL ON public.task_logs TO service_role;
ALTER TABLE public.task_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner all task_logs" ON public.task_logs
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX IF NOT EXISTS task_logs_run_idx ON public.task_logs(run_id);

-- 5. cost_metrics
CREATE TABLE IF NOT EXISTS public.cost_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  server_id uuid NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
  day date NOT NULL,
  daily_cost numeric(10,4) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'USD',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (server_id, day)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cost_metrics TO authenticated;
GRANT ALL ON public.cost_metrics TO service_role;
ALTER TABLE public.cost_metrics ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner all cost_metrics" ON public.cost_metrics
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX IF NOT EXISTS cost_metrics_user_day_idx ON public.cost_metrics(user_id, day DESC);

-- 6. updated_at trigger for automation_tasks
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS automation_tasks_touch ON public.automation_tasks;
CREATE TRIGGER automation_tasks_touch BEFORE UPDATE ON public.automation_tasks
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
