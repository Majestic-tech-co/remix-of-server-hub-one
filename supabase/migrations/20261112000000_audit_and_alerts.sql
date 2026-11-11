-- Audit log (who did what) and in-app alerts (server offline / high usage).

-- ───────────────────────── audit_log ─────────────────────────
-- No FK on user_id on purpose: deleting an account cascades through servers, whose delete
-- trigger must not try to log against a user row that is already gone.
CREATE TABLE IF NOT EXISTS public.audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     uuid NOT NULL,
  action      text NOT NULL CHECK (char_length(action) <= 64),
  target_type text CHECK (target_type IS NULL OR char_length(target_type) <= 32),
  target_id   uuid,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_user_created_idx ON public.audit_log (user_id, created_at DESC);

ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "owner select audit_log" ON public.audit_log;
CREATE POLICY "owner select audit_log" ON public.audit_log FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

REVOKE ALL ON public.audit_log FROM anon, authenticated;
GRANT SELECT ON public.audit_log TO authenticated;
GRANT ALL ON public.audit_log TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.audit_log_id_seq TO service_role;

-- Every queued command is recorded, whoever inserts it (UI, playbook, direct API call).
CREATE OR REPLACE FUNCTION public.audit_command_queued()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.audit_log (user_id, action, target_type, target_id, detail)
  VALUES (NEW.user_id, 'command.queued', 'server', NEW.server_id,
          jsonb_build_object('command_id', NEW.id, 'command', left(NEW.command, 500)));
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.audit_command_queued() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS audit_command_queued_trg ON public.commands;
CREATE TRIGGER audit_command_queued_trg AFTER INSERT ON public.commands
  FOR EACH ROW EXECUTE FUNCTION public.audit_command_queued();

-- Server deletions are recorded unless the whole account is being deleted.
CREATE OR REPLACE FUNCTION public.audit_server_deleted()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM auth.users u WHERE u.id = OLD.user_id) THEN
    INSERT INTO public.audit_log (user_id, action, target_type, target_id, detail)
    VALUES (OLD.user_id, 'server.deleted', 'server', OLD.id, jsonb_build_object('name', left(OLD.name, 100)));
  END IF;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION public.audit_server_deleted() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS audit_server_deleted_trg ON public.servers;
CREATE TRIGGER audit_server_deleted_trg AFTER DELETE ON public.servers
  FOR EACH ROW EXECUTE FUNCTION public.audit_server_deleted();

-- ───────────────────────── alerts ─────────────────────────
CREATE TABLE IF NOT EXISTS public.alerts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  server_id    uuid NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('offline', 'cpu', 'memory', 'disk')),
  message      text NOT NULL CHECK (char_length(message) <= 300),
  acknowledged boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz
);
-- At most one OPEN alert per server and kind.
CREATE UNIQUE INDEX IF NOT EXISTS alerts_one_open_idx ON public.alerts (server_id, kind) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS alerts_user_idx ON public.alerts (user_id, created_at DESC);

ALTER TABLE public.alerts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "owner select alerts" ON public.alerts;
CREATE POLICY "owner select alerts" ON public.alerts FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "owner ack alerts" ON public.alerts;
CREATE POLICY "owner ack alerts" ON public.alerts FOR UPDATE TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

REVOKE ALL ON public.alerts FROM anon, authenticated;
GRANT SELECT ON public.alerts TO authenticated;
GRANT UPDATE (acknowledged) ON public.alerts TO authenticated;   -- users can only acknowledge
GRANT ALL ON public.alerts TO service_role;

-- Thresholds: offline after 5 min of silence; CPU / memory / disk at 90% (clears below 80%).
CREATE OR REPLACE FUNCTION public.evaluate_alerts()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- offline
  INSERT INTO public.alerts (user_id, server_id, kind, message)
  SELECT s.user_id, s.id, 'offline', left(s.name, 100) || ' has stopped reporting'
    FROM public.servers s
   WHERE s.last_seen_at IS NOT NULL AND s.last_seen_at < now() - interval '5 minutes'
  ON CONFLICT (server_id, kind) WHERE resolved_at IS NULL DO NOTHING;

  UPDATE public.alerts a SET resolved_at = now()
    FROM public.servers s
   WHERE a.server_id = s.id AND a.kind = 'offline' AND a.resolved_at IS NULL
     AND s.last_seen_at >= now() - interval '5 minutes';

  -- high usage, from each server's most recent sample in the last 5 minutes
  WITH latest AS (
    SELECT DISTINCT ON (server_id) server_id, cpu_percent, memory_percent, disk_percent
      FROM public.metrics
     WHERE recorded_at > now() - interval '5 minutes'
     ORDER BY server_id, recorded_at DESC
  ), breaches AS (
    SELECT server_id, 'cpu'::text AS kind, cpu_percent AS val FROM latest WHERE cpu_percent >= 90
    UNION ALL SELECT server_id, 'memory', memory_percent FROM latest WHERE memory_percent >= 90
    UNION ALL SELECT server_id, 'disk', disk_percent FROM latest WHERE disk_percent >= 90
  )
  INSERT INTO public.alerts (user_id, server_id, kind, message)
  SELECT s.user_id, b.server_id, b.kind, left(s.name, 100) || ' ' || b.kind || ' usage is at ' || round(b.val) || '%'
    FROM breaches b JOIN public.servers s ON s.id = b.server_id
  ON CONFLICT (server_id, kind) WHERE resolved_at IS NULL DO NOTHING;

  UPDATE public.alerts a SET resolved_at = now()
   WHERE a.resolved_at IS NULL AND a.kind IN ('cpu', 'memory', 'disk')
     AND EXISTS (
       SELECT 1 FROM (
         SELECT DISTINCT ON (server_id) server_id, cpu_percent, memory_percent, disk_percent
           FROM public.metrics
          WHERE recorded_at > now() - interval '5 minutes'
          ORDER BY server_id, recorded_at DESC
       ) l
        WHERE l.server_id = a.server_id
          AND coalesce(CASE a.kind WHEN 'cpu' THEN l.cpu_percent WHEN 'memory' THEN l.memory_percent ELSE l.disk_percent END, 0) < 80
     );
END;
$$;
REVOKE ALL ON FUNCTION public.evaluate_alerts() FROM PUBLIC, anon, authenticated;

-- ───────────────────────── retention ─────────────────────────
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

  DELETE FROM public.alerts WHERE resolved_at IS NOT NULL AND resolved_at < now() - interval '30 days';
  DELETE FROM public.audit_log WHERE created_at < now() - interval '365 days';
END;
$$;
REVOKE ALL ON FUNCTION public.purge_old_data() FROM PUBLIC, anon, authenticated;

-- ───────────────────────── schedule ─────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'fleet-evaluate-alerts';
    PERFORM cron.schedule('fleet-evaluate-alerts', '* * * * *', 'SELECT public.evaluate_alerts();');
  ELSE
    RAISE NOTICE 'pg_cron not available: enable it and run  SELECT cron.schedule(''fleet-evaluate-alerts'', ''* * * * *'', ''SELECT public.evaluate_alerts();'');';
  END IF;
END
$$;
