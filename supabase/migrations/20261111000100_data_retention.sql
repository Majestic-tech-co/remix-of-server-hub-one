-- Data retention: bounded growth for high-volume tables.
--   metrics               30 days
--   terminal_sessions      7 days after closing (stale open sessions are closed after 1 hour idle)
--   commands              90 days (task_logs keep their text; command_id is set NULL)
-- Scheduled daily at 03:17 UTC with pg_cron when that extension is available.

CREATE OR REPLACE FUNCTION public.purge_old_data()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
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

-- Never callable from the API; only the database scheduler / admins.
REVOKE ALL ON FUNCTION public.purge_old_data() FROM PUBLIC, anon, authenticated;

-- Index so the purge doesn't scan the whole table.
CREATE INDEX IF NOT EXISTS metrics_recorded_at_idx ON public.metrics (recorded_at);

-- Schedule with pg_cron if it can be enabled (Supabase: Database → Extensions → pg_cron).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'fleet-purge-old-data';
    PERFORM cron.schedule('fleet-purge-old-data', '17 3 * * *', 'SELECT public.purge_old_data();');
  ELSE
    RAISE NOTICE 'pg_cron not available: enable it and run  SELECT cron.schedule(''fleet-purge-old-data'', ''17 3 * * *'', ''SELECT public.purge_old_data();'');';
  END IF;
END
$$;
