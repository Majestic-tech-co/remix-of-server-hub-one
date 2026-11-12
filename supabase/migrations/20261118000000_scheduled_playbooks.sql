-- Scheduled playbooks: run a playbook automatically (daily / weekly / monthly) on all or selected servers.
-- Runs entirely inside the database: pg_cron calls run_due_schedules() every minute.
--
-- Safety rules (all enforced in SQL and tested):
--   * only admins can create/change/delete schedules; the schedule runs as the last admin who changed it
--   * if that person is no longer an admin of the team, the schedule disables itself instead of running
--   * an occurrence missed by more than 2 hours (system was down) is skipped, never run late
--   * a schedule never starts a new run while its previous run is still going
--   * monitoring-only and offline servers are skipped (recorded with a reason), never queued
--   * every created/changed/deleted schedule and playbook, and every scheduled start, is in the audit log

-- ───────────────────────── table ─────────────────────────
CREATE TABLE IF NOT EXISTS public.playbook_schedules (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  task_id       uuid NOT NULL REFERENCES public.automation_tasks(id) ON DELETE CASCADE,
  name          text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  all_servers   boolean NOT NULL DEFAULT false,
  server_ids    uuid[] NOT NULL DEFAULT '{}',
  frequency     text NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly')),
  time_of_day   time NOT NULL DEFAULT '03:00',
  day_of_week   smallint CHECK (day_of_week BETWEEN 0 AND 6),     -- 0 = Sunday
  day_of_month  smallint CHECK (day_of_month BETWEEN 1 AND 28),   -- capped at 28 so every month has it
  timezone      text NOT NULL DEFAULT 'UTC',
  enabled       boolean NOT NULL DEFAULT true,
  next_run_at   timestamptz,
  last_run_at   timestamptz,
  last_run_id   uuid REFERENCES public.automation_runs(id) ON DELETE SET NULL,
  last_result   text CHECK (last_result IS NULL OR char_length(last_result) <= 300),
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT schedule_targets CHECK (
    (all_servers AND cardinality(server_ids) = 0) OR (NOT all_servers AND cardinality(server_ids) BETWEEN 1 AND 100)
  ),
  CONSTRAINT schedule_weekly CHECK (frequency <> 'weekly' OR day_of_week IS NOT NULL),
  CONSTRAINT schedule_monthly CHECK (frequency <> 'monthly' OR day_of_month IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS playbook_schedules_due_idx ON public.playbook_schedules (next_run_at) WHERE enabled;
CREATE INDEX IF NOT EXISTS playbook_schedules_workspace_idx ON public.playbook_schedules (workspace_id);

-- ───────────────────────── when is the next run? ─────────────────────────
-- The next wall-clock occurrence strictly after `after`, in the schedule's time zone (daylight saving aware:
-- a time that doesn't exist on the spring-forward night shifts forward by an hour).
CREATE OR REPLACE FUNCTION public.compute_next_run(freq text, tod time, dow integer, dom integer, tz text, after timestamptz)
RETURNS timestamptz LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE
  d date := (after AT TIME ZONE tz)::date;
  cand timestamp;
  i integer;
BEGIN
  FOR i IN 0..400 LOOP
    cand := (d + i) + tod;
    IF freq = 'weekly'  AND extract(dow from cand)::integer <> dow THEN CONTINUE; END IF;
    IF freq = 'monthly' AND extract(day from cand)::integer <> dom THEN CONTINUE; END IF;
    IF (cand AT TIME ZONE tz) > after THEN RETURN cand AT TIME ZONE tz; END IF;
  END LOOP;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.compute_next_run(text, time, integer, integer, text, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.compute_next_run(text, time, integer, integer, text, timestamptz) TO authenticated, service_role;

-- ───────────────────────── validation on every write ─────────────────────────
CREATE OR REPLACE FUNCTION public.schedules_before_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  sid uuid;
  schedule_changed boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF (SELECT count(*) FROM public.playbook_schedules WHERE workspace_id = NEW.workspace_id) >= 50 THEN
      RAISE EXCEPTION 'schedule limit reached for this team' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    NEW.workspace_id := OLD.workspace_id;       -- never moves between teams
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names z WHERE z.name = NEW.timezone) THEN
    RAISE EXCEPTION 'unknown time zone' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.automation_tasks t WHERE t.id = NEW.task_id AND t.workspace_id = NEW.workspace_id) THEN
    RAISE EXCEPTION 'playbook not found in this team' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT NEW.all_servers THEN
    NEW.server_ids := ARRAY(SELECT DISTINCT x FROM unnest(NEW.server_ids) x);
    FOREACH sid IN ARRAY NEW.server_ids LOOP
      IF NOT EXISTS (SELECT 1 FROM public.servers s WHERE s.id = sid AND s.workspace_id = NEW.workspace_id) THEN
        RAISE EXCEPTION 'server not found in this team' USING ERRCODE = 'check_violation';
      END IF;
    END LOOP;
  END IF;

  -- fields that don't apply to the chosen frequency are cleared
  IF NEW.frequency = 'daily'  THEN NEW.day_of_week := NULL; NEW.day_of_month := NULL; END IF;
  IF NEW.frequency = 'weekly' THEN NEW.day_of_month := NULL; END IF;
  IF NEW.frequency = 'monthly' THEN NEW.day_of_week := NULL; END IF;

  schedule_changed := TG_OP = 'INSERT' OR (
       NEW.frequency IS DISTINCT FROM OLD.frequency OR NEW.time_of_day IS DISTINCT FROM OLD.time_of_day
    OR NEW.day_of_week IS DISTINCT FROM OLD.day_of_week OR NEW.day_of_month IS DISTINCT FROM OLD.day_of_month
    OR NEW.timezone IS DISTINCT FROM OLD.timezone OR NEW.enabled IS DISTINCT FROM OLD.enabled);
  IF schedule_changed THEN
    NEW.next_run_at := CASE WHEN NEW.enabled
      THEN public.compute_next_run(NEW.frequency, NEW.time_of_day, NEW.day_of_week, NEW.day_of_month, NEW.timezone, now())
      ELSE NULL END;
  END IF;

  -- the person who last changed a schedule is the one it runs as (and answers for)
  IF TG_OP = 'UPDATE' AND auth.uid() IS NOT NULL AND (schedule_changed OR NEW.task_id IS DISTINCT FROM OLD.task_id
       OR NEW.all_servers IS DISTINCT FROM OLD.all_servers OR NEW.server_ids IS DISTINCT FROM OLD.server_ids) THEN
    NEW.created_by := auth.uid();
  ELSIF TG_OP = 'UPDATE' THEN
    NEW.created_by := OLD.created_by;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.schedules_before_write() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS schedules_before_write_trg ON public.playbook_schedules;
CREATE TRIGGER schedules_before_write_trg BEFORE INSERT OR UPDATE ON public.playbook_schedules
  FOR EACH ROW EXECUTE FUNCTION public.schedules_before_write();

-- ───────────────────────── access ─────────────────────────
ALTER TABLE public.playbook_schedules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "members read schedules" ON public.playbook_schedules FOR SELECT TO authenticated
  USING (public.has_role(workspace_id, 'member'));
CREATE POLICY "admins create schedules" ON public.playbook_schedules FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid() AND public.has_role(workspace_id, 'admin'));
CREATE POLICY "admins edit schedules" ON public.playbook_schedules FOR UPDATE TO authenticated
  USING (public.has_role(workspace_id, 'admin')) WITH CHECK (public.has_role(workspace_id, 'admin'));
CREATE POLICY "admins delete schedules" ON public.playbook_schedules FOR DELETE TO authenticated
  USING (public.has_role(workspace_id, 'admin'));

REVOKE ALL ON public.playbook_schedules FROM anon, authenticated;
GRANT SELECT ON public.playbook_schedules TO authenticated;
GRANT INSERT (workspace_id, task_id, name, all_servers, server_ids, frequency, time_of_day, day_of_week, day_of_month,
              timezone, enabled, created_by) ON public.playbook_schedules TO authenticated;
GRANT UPDATE (task_id, name, all_servers, server_ids, frequency, time_of_day, day_of_week, day_of_month, timezone, enabled)
  ON public.playbook_schedules TO authenticated;     -- never next_run_at / last_* (system-managed)
GRANT DELETE ON public.playbook_schedules TO authenticated;
GRANT ALL ON public.playbook_schedules TO service_role;

-- ───────────────────────── runs finish from per-server results ─────────────────────────
-- A target can now be recorded as skipped (no command), so "finished" is decided by each task_log's own status.
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
    UPDATE public.task_logs l
       SET status = CASE WHEN NEW.status = 'completed' AND coalesce(NEW.exit_code, 0) = 0 THEN 'success' ELSE 'failed' END
     WHERE l.command_id = NEW.id AND l.run_id = v_run;

    SELECT r.target_count INTO v_target FROM public.automation_runs r WHERE r.id = v_run;
    SELECT count(*),
           count(*) FILTER (WHERE l.status = 'pending'),
           count(*) FILTER (WHERE l.status = 'failed')
      INTO v_logs, v_open, v_failed
      FROM public.task_logs l WHERE l.run_id = v_run;

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

-- ───────────────────────── the engine ─────────────────────────
-- Handles ONE due schedule. Returns 1 if it started a run. Called inside a sub-transaction by run_due_schedules()
-- so one broken schedule can never block the others.
CREATE OR REPLACE FUNCTION public.run_one_schedule(s public.playbook_schedules, v_next timestamptz) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_task public.automation_tasks%ROWTYPE;
  v_run uuid;
  v_total integer;
  v_cmds integer := 0;
  v_skipped integer := 0;
  v_cmd uuid;
  v_note text;
  srv record;
BEGIN
  -- 1. the system was unavailable at the scheduled time: never run late
  IF now() - s.next_run_at > interval '2 hours' THEN
    UPDATE public.playbook_schedules SET next_run_at = v_next, last_result = 'skipped: missed its time window' WHERE id = s.id;
    RETURN 0;
  END IF;

  -- 2. whoever it runs as must still be an admin of the team
  IF s.created_by IS NULL OR NOT EXISTS (
       SELECT 1 FROM public.workspace_members m
        WHERE m.workspace_id = s.workspace_id AND m.user_id = s.created_by
          AND public.role_rank(m.role) >= public.role_rank('admin')) THEN
    UPDATE public.playbook_schedules SET enabled = false, next_run_at = NULL,
           last_result = 'disabled: the person it runs as no longer has admin access to this team' WHERE id = s.id;
    INSERT INTO public.audit_log (user_id, workspace_id, action, target_type, target_id, detail)
    VALUES (NULL, s.workspace_id, 'schedule.disabled', 'schedule', s.id,
            jsonb_build_object('name', left(s.name, 100), 'reason', 'owner lost admin access'));
    RETURN 0;
  END IF;

  -- 3. never pile runs up
  IF s.last_run_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.automation_runs r WHERE r.id = s.last_run_id AND r.status = 'running') THEN
    UPDATE public.playbook_schedules SET next_run_at = v_next, last_result = 'skipped: the previous run is still in progress' WHERE id = s.id;
    RETURN 0;
  END IF;

  SELECT * INTO v_task FROM public.automation_tasks t WHERE t.id = s.task_id AND t.workspace_id = s.workspace_id;
  IF NOT FOUND THEN
    UPDATE public.playbook_schedules SET enabled = false, next_run_at = NULL, last_result = 'disabled: the playbook no longer exists' WHERE id = s.id;
    RETURN 0;
  END IF;

  SELECT count(*) INTO v_total FROM public.servers sv
   WHERE sv.workspace_id = s.workspace_id AND (s.all_servers OR sv.id = ANY (s.server_ids));
  IF v_total = 0 THEN
    UPDATE public.playbook_schedules SET next_run_at = v_next, last_result = 'skipped: no matching servers' WHERE id = s.id;
    RETURN 0;
  END IF;

  INSERT INTO public.automation_runs (user_id, workspace_id, task_id, status, target_count)
  VALUES (s.created_by, s.workspace_id, s.task_id, 'running', least(v_total, 500))
  RETURNING id INTO v_run;

  FOR srv IN
    SELECT sv.id, sv.remote_access, sv.last_seen_at FROM public.servers sv
     WHERE sv.workspace_id = s.workspace_id AND (s.all_servers OR sv.id = ANY (s.server_ids))
     ORDER BY sv.name LIMIT 500
  LOOP
    v_note := NULL;
    IF NOT srv.remote_access THEN
      v_note := 'Skipped: this server is monitoring-only.';
    ELSIF srv.last_seen_at IS NULL OR srv.last_seen_at < now() - interval '5 minutes' THEN
      v_note := 'Skipped: the server was offline when the schedule ran.';
    END IF;

    IF v_note IS NOT NULL THEN
      INSERT INTO public.task_logs (user_id, run_id, server_id, status, output_log)
      VALUES (s.created_by, v_run, srv.id, 'failed', v_note);
      v_skipped := v_skipped + 1;
    ELSE
      INSERT INTO public.commands (user_id, server_id, command) VALUES (s.created_by, srv.id, v_task.script_content)
      RETURNING id INTO v_cmd;
      INSERT INTO public.task_logs (user_id, run_id, server_id, command_id, status)
      VALUES (s.created_by, v_run, srv.id, v_cmd, 'pending');
      v_cmds := v_cmds + 1;
    END IF;
  END LOOP;

  IF v_cmds = 0 THEN   -- nothing could be started: the run is over immediately
    UPDATE public.automation_runs SET status = 'failed', finished_at = now() WHERE id = v_run;
  END IF;

  UPDATE public.playbook_schedules SET last_run_at = now(), last_run_id = v_run, next_run_at = v_next,
         last_result = CASE WHEN v_cmds = 0 THEN 'nothing started: every server was skipped'
                            WHEN v_skipped = 0 THEN 'started on ' || v_cmds || ' server' || CASE WHEN v_cmds = 1 THEN '' ELSE 's' END
                            ELSE 'started on ' || v_cmds || ', skipped ' || v_skipped END
   WHERE id = s.id;
  INSERT INTO public.audit_log (user_id, workspace_id, action, target_type, target_id, detail)
  VALUES (s.created_by, s.workspace_id, 'schedule.ran', 'schedule', s.id,
          jsonb_build_object('name', left(s.name, 100), 'started', v_cmds, 'skipped', v_skipped, 'run_id', v_run));
  RETURN 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.run_due_schedules() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s public.playbook_schedules%ROWTYPE;
  v_next timestamptz;
  v_started integer := 0;
BEGIN
  FOR s IN
    SELECT * FROM public.playbook_schedules sc
     WHERE sc.enabled AND sc.next_run_at IS NOT NULL AND sc.next_run_at <= now()
     ORDER BY sc.next_run_at LIMIT 100
       FOR UPDATE SKIP LOCKED
  LOOP
    v_next := public.compute_next_run(s.frequency, s.time_of_day, s.day_of_week, s.day_of_month, s.timezone, now());
    BEGIN
      v_started := v_started + public.run_one_schedule(s, v_next);
    EXCEPTION WHEN OTHERS THEN
      UPDATE public.playbook_schedules SET next_run_at = v_next, last_result = left('error: ' || SQLERRM, 300) WHERE id = s.id;
    END;
  END LOOP;
  RETURN v_started;
END;
$$;
REVOKE ALL ON FUNCTION public.run_one_schedule(public.playbook_schedules, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.run_due_schedules() FROM PUBLIC, anon, authenticated;

-- ───────────────────────── audit trail ─────────────────────────
CREATE OR REPLACE FUNCTION public.audit_schedule_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.playbook_schedules%ROWTYPE;
BEGIN
  r := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  -- a delete caused by deleting the whole team/playbook is not interesting (and the team may be gone)
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id = r.workspace_id) THEN RETURN OLD; END IF;
  INSERT INTO public.audit_log (user_id, workspace_id, action, target_type, target_id, detail)
  VALUES (coalesce(auth.uid(), r.created_by), r.workspace_id,
          CASE TG_OP WHEN 'INSERT' THEN 'schedule.created' WHEN 'UPDATE' THEN 'schedule.updated' ELSE 'schedule.deleted' END,
          'schedule', r.id,
          jsonb_build_object('name', left(r.name, 100), 'frequency', r.frequency, 'enabled', r.enabled));
  RETURN r;
END;
$$;
REVOKE ALL ON FUNCTION public.audit_schedule_change() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS audit_schedule_ins_trg ON public.playbook_schedules;
CREATE TRIGGER audit_schedule_ins_trg AFTER INSERT ON public.playbook_schedules FOR EACH ROW EXECUTE FUNCTION public.audit_schedule_change();
DROP TRIGGER IF EXISTS audit_schedule_upd_trg ON public.playbook_schedules;
CREATE TRIGGER audit_schedule_upd_trg AFTER UPDATE OF name, task_id, all_servers, server_ids, frequency, time_of_day, day_of_week, day_of_month, timezone, enabled
  ON public.playbook_schedules FOR EACH ROW EXECUTE FUNCTION public.audit_schedule_change();
DROP TRIGGER IF EXISTS audit_schedule_del_trg ON public.playbook_schedules;
CREATE TRIGGER audit_schedule_del_trg AFTER DELETE ON public.playbook_schedules FOR EACH ROW EXECUTE FUNCTION public.audit_schedule_change();

-- Editing a playbook changes what its schedules run, so playbook changes are audited too.
CREATE OR REPLACE FUNCTION public.audit_playbook_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.automation_tasks%ROWTYPE;
BEGIN
  r := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id = r.workspace_id) THEN RETURN OLD; END IF;
  INSERT INTO public.audit_log (user_id, workspace_id, action, target_type, target_id, detail)
  VALUES (coalesce(auth.uid(), r.user_id), r.workspace_id,
          CASE TG_OP WHEN 'INSERT' THEN 'playbook.created' WHEN 'UPDATE' THEN 'playbook.updated' ELSE 'playbook.deleted' END,
          'playbook', r.id,
          jsonb_build_object('name', left(r.name, 100),
                             'script_changed', TG_OP = 'UPDATE' AND NEW.script_content IS DISTINCT FROM OLD.script_content));
  RETURN r;
END;
$$;
REVOKE ALL ON FUNCTION public.audit_playbook_change() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS audit_playbook_ins_trg ON public.automation_tasks;
CREATE TRIGGER audit_playbook_ins_trg AFTER INSERT ON public.automation_tasks FOR EACH ROW EXECUTE FUNCTION public.audit_playbook_change();
DROP TRIGGER IF EXISTS audit_playbook_upd_trg ON public.automation_tasks;
CREATE TRIGGER audit_playbook_upd_trg AFTER UPDATE OF name, description, script_content ON public.automation_tasks FOR EACH ROW EXECUTE FUNCTION public.audit_playbook_change();
DROP TRIGGER IF EXISTS audit_playbook_del_trg ON public.automation_tasks;
CREATE TRIGGER audit_playbook_del_trg AFTER DELETE ON public.automation_tasks FOR EACH ROW EXECUTE FUNCTION public.audit_playbook_change();

-- ───────────────────────── the clock ─────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'fleet-run-schedules';
    PERFORM cron.schedule('fleet-run-schedules', '* * * * *', 'SELECT public.run_due_schedules();');
  ELSE
    RAISE NOTICE 'pg_cron not available: enable it and run  SELECT cron.schedule(''fleet-run-schedules'', ''* * * * *'', ''SELECT public.run_due_schedules();'');';
  END IF;
END
$$;
