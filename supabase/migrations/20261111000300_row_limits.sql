-- Per-user row caps so a signed-in user cannot fill the database through the Data API
-- (storage / cost abuse). Server-side routes using the service role are not limited.
-- Limits are generous for real use; raise them here if you ever need to.

CREATE INDEX IF NOT EXISTS commands_user_idx         ON public.commands (user_id);
CREATE INDEX IF NOT EXISTS task_logs_user_idx        ON public.task_logs (user_id);
CREATE INDEX IF NOT EXISTS cost_metrics_user_idx     ON public.cost_metrics (user_id);
CREATE INDEX IF NOT EXISTS automation_tasks_user_idx ON public.automation_tasks (user_id);

CREATE OR REPLACE FUNCTION public.enforce_row_limit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  max_rows integer := TG_ARGV[0]::integer;
  current_rows bigint;
BEGIN
  EXECUTE format('SELECT count(*) FROM %I.%I WHERE user_id = $1', TG_TABLE_SCHEMA, TG_TABLE_NAME)
    INTO current_rows USING NEW.user_id;
  IF current_rows >= max_rows THEN
    RAISE EXCEPTION 'row limit reached for %', TG_TABLE_NAME USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_row_limit() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS limit_commands ON public.commands;
CREATE TRIGGER limit_commands BEFORE INSERT ON public.commands
  FOR EACH ROW WHEN (current_setting('role', true) <> 'service_role')
  EXECUTE FUNCTION public.enforce_row_limit('20000');

DROP TRIGGER IF EXISTS limit_automation_tasks ON public.automation_tasks;
CREATE TRIGGER limit_automation_tasks BEFORE INSERT ON public.automation_tasks
  FOR EACH ROW WHEN (current_setting('role', true) <> 'service_role')
  EXECUTE FUNCTION public.enforce_row_limit('500');

DROP TRIGGER IF EXISTS limit_automation_runs ON public.automation_runs;
CREATE TRIGGER limit_automation_runs BEFORE INSERT ON public.automation_runs
  FOR EACH ROW WHEN (current_setting('role', true) <> 'service_role')
  EXECUTE FUNCTION public.enforce_row_limit('10000');

DROP TRIGGER IF EXISTS limit_task_logs ON public.task_logs;
CREATE TRIGGER limit_task_logs BEFORE INSERT ON public.task_logs
  FOR EACH ROW WHEN (current_setting('role', true) <> 'service_role')
  EXECUTE FUNCTION public.enforce_row_limit('100000');

DROP TRIGGER IF EXISTS limit_cost_metrics ON public.cost_metrics;
CREATE TRIGGER limit_cost_metrics BEFORE INSERT ON public.cost_metrics
  FOR EACH ROW WHEN (current_setting('role', true) <> 'service_role')
  EXECUTE FUNCTION public.enforce_row_limit('100000');
