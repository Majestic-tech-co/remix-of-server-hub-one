-- If the agent restarts (or the server reboots) while a command is running, the command
-- would stay 'running' forever. The daily purge now marks such commands as failed.
-- Also marks commands nobody picked up for 24h (agent offline) as failed.

CREATE OR REPLACE FUNCTION public.purge_old_data()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- orphaned / never-picked-up commands
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
   WHERE status IN ('requested', 'active')
     AND last_client_poll_at < now() - interval '1 hour';

  DELETE FROM public.terminal_sessions
   WHERE status = 'closed' AND coalesce(closed_at, created_at) < now() - interval '7 days';

  DELETE FROM public.commands
   WHERE status IN ('completed', 'failed') AND created_at < now() - interval '90 days';
END;
$$;

REVOKE ALL ON FUNCTION public.purge_old_data() FROM PUBLIC, anon, authenticated;
