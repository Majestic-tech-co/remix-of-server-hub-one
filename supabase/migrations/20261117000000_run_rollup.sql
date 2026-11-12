-- Playbook runs finish on their own.
--
-- Before: a run's status ("running" -> "success"/"failed") was only updated by the run page in someone's
-- browser, and a bug there meant it never happened. Now the database does it the moment a command
-- finishes, whether or not anyone is looking.

-- How many servers the run was started on, so a fast first result can't close the run before the other
-- servers' rows have been created. (NULL for runs started before this existed.)
ALTER TABLE public.automation_runs ADD COLUMN IF NOT EXISTS target_count integer
  CHECK (target_count IS NULL OR target_count BETWEEN 1 AND 500);

CREATE OR REPLACE FUNCTION public.rollup_run_from_command() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_run uuid;
  v_target integer;
  v_logs integer;
  v_open integer;
  v_failed integer;
BEGIN
  FOR v_run IN SELECT DISTINCT l.run_id FROM public.task_logs l WHERE l.command_id = NEW.id LOOP
    -- this server's row
    UPDATE public.task_logs l
       SET status = CASE WHEN NEW.status = 'completed' AND coalesce(NEW.exit_code, 0) = 0 THEN 'success' ELSE 'failed' END
     WHERE l.command_id = NEW.id AND l.run_id = v_run;

    -- is the whole run finished?
    SELECT r.target_count INTO v_target FROM public.automation_runs r WHERE r.id = v_run;
    SELECT count(*),
           count(*) FILTER (WHERE c.id IS NULL OR c.status NOT IN ('completed', 'failed')),
           count(*) FILTER (WHERE c.status = 'failed' OR coalesce(c.exit_code, 0) <> 0)
      INTO v_logs, v_open, v_failed
      FROM public.task_logs l LEFT JOIN public.commands c ON c.id = l.command_id
     WHERE l.run_id = v_run;

    IF v_open = 0 AND v_logs >= coalesce(v_target, v_logs) THEN
      UPDATE public.automation_runs r
         SET status = CASE WHEN v_failed > 0 THEN 'failed' ELSE 'success' END, finished_at = now()
       WHERE r.id = v_run AND r.status = 'running';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION public.rollup_run_from_command() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS rollup_run_from_command_trg ON public.commands;
CREATE TRIGGER rollup_run_from_command_trg AFTER UPDATE OF status ON public.commands
  FOR EACH ROW WHEN (NEW.status IN ('completed', 'failed') AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.rollup_run_from_command();

-- Fix runs that are already stuck: finished commands -> finish the run; ancient leftovers -> abandoned.
UPDATE public.task_logs l
   SET status = CASE WHEN c.status = 'completed' AND coalesce(c.exit_code, 0) = 0 THEN 'success' ELSE 'failed' END
  FROM public.commands c
 WHERE c.id = l.command_id AND c.status IN ('completed', 'failed') AND l.status = 'pending';

UPDATE public.automation_runs r
   SET status = CASE WHEN EXISTS (
         SELECT 1 FROM public.task_logs l JOIN public.commands c ON c.id = l.command_id
          WHERE l.run_id = r.id AND (c.status = 'failed' OR coalesce(c.exit_code, 0) <> 0)
       ) THEN 'failed' ELSE 'success' END,
       finished_at = now()
 WHERE r.status = 'running'
   AND EXISTS (SELECT 1 FROM public.task_logs l WHERE l.run_id = r.id)
   AND NOT EXISTS (
         SELECT 1 FROM public.task_logs l LEFT JOIN public.commands c ON c.id = l.command_id
          WHERE l.run_id = r.id AND (c.id IS NULL OR c.status NOT IN ('completed', 'failed')));

UPDATE public.automation_runs SET status = 'failed', finished_at = now()
 WHERE status = 'running' AND started_at < now() - interval '1 day';

-- the nightly cleanup, plus abandoned runs
CREATE OR REPLACE FUNCTION public.purge_old_data()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.commands
     SET status = 'failed',
         exit_code = coalesce(exit_code, -1),
         stderr = coalesce(stderr, '') || E'\n[fleet] command did not finish (agent restarted or was offline)',
         completed_at = now()
   WHERE (status = 'running' AND coalesce(started_at, created_at) < now() - interval '2 hours')
      OR (status = 'pending' AND created_at < now() - interval '24 hours');

  DELETE FROM public.metrics WHERE recorded_at < now() - interval '30 days';

  UPDATE public.terminal_sessions
     SET status = 'closed', closed_at = now()
   WHERE status IN ('requested', 'active') AND last_client_poll_at < now() - interval '1 hour';

  DELETE FROM public.terminal_sessions
   WHERE status = 'closed' AND coalesce(closed_at, created_at) < now() - interval '7 days';

  DELETE FROM public.commands
   WHERE status IN ('completed', 'failed') AND created_at < now() - interval '90 days';

  -- a playbook run still 'running' after a day was abandoned (agent offline, command lost): close it
  UPDATE public.automation_runs SET status = 'failed', finished_at = now()
   WHERE status = 'running' AND started_at < now() - interval '1 day';

  DELETE FROM public.alerts WHERE resolved_at IS NOT NULL AND resolved_at < now() - interval '30 days';
  DELETE FROM public.audit_log WHERE created_at < now() - interval '365 days';
END;
$$;
REVOKE ALL ON FUNCTION public.purge_old_data() FROM PUBLIC, anon, authenticated;

