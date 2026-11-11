-- Teams: data belongs to a workspace, people belong to workspaces with a role.
--
--   owner   everything, incl. managing owners/admins and deleting the workspace
--   admin   add/edit/delete servers, rotate tokens, edit playbooks, invite members, read audit log
--   member  run commands + playbooks, open terminals, acknowledge alerts
--   viewer  read-only: servers, metrics, alerts, playbooks
--
-- Existing data is moved into one personal workspace per user (that user is its owner).

-- ───────────────────────── core tables ─────────────────────────
CREATE TABLE IF NOT EXISTS public.workspaces (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.workspace_members (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS workspace_members_user_idx ON public.workspace_members (user_id);

CREATE TABLE IF NOT EXISTS public.workspace_invites (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  email        text NOT NULL CHECK (char_length(email) BETWEEN 3 AND 254),
  role         text NOT NULL CHECK (role IN ('admin', 'member', 'viewer')),
  invited_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  accepted_at  timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS workspace_invites_open_idx
  ON public.workspace_invites (workspace_id, lower(email)) WHERE accepted_at IS NULL;

-- ───────────────────────── role helpers ─────────────────────────
CREATE OR REPLACE FUNCTION public.role_rank(r text) RETURNS integer
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE r WHEN 'owner' THEN 4 WHEN 'admin' THEN 3 WHEN 'member' THEN 2 WHEN 'viewer' THEN 1 ELSE 0 END
$$;

-- Does the signed-in user hold at least `min_role` in workspace `ws`?
-- SECURITY DEFINER so it can read workspace_members without recursing through its own RLS.
CREATE OR REPLACE FUNCTION public.has_role(ws uuid, min_role text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.workspace_members m
     WHERE m.workspace_id = ws AND m.user_id = auth.uid()
       AND public.role_rank(m.role) >= public.role_rank(min_role)
  )
$$;

REVOKE ALL ON FUNCTION public.role_rank(text), public.has_role(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.role_rank(text), public.has_role(uuid, text) TO authenticated, service_role;

-- ───────────────────────── attach data to workspaces ─────────────────────────
-- cost_metrics was removed from the app; drop it (also removes its policies and triggers).
DROP TABLE IF EXISTS public.cost_metrics CASCADE;

ALTER TABLE public.servers          ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES public.workspaces(id) ON DELETE CASCADE;
ALTER TABLE public.automation_tasks ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES public.workspaces(id) ON DELETE CASCADE;
ALTER TABLE public.automation_runs  ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES public.workspaces(id) ON DELETE CASCADE;
ALTER TABLE public.alerts           ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES public.workspaces(id) ON DELETE CASCADE;
ALTER TABLE public.audit_log        ADD COLUMN IF NOT EXISTS workspace_id uuid;

-- Backfill: one personal workspace per user who already owns data.
CREATE TEMP TABLE _ws_map AS
  SELECT u AS user_id, gen_random_uuid() AS ws
    FROM (SELECT user_id AS u FROM public.servers
          UNION SELECT user_id FROM public.automation_tasks
          UNION SELECT user_id FROM public.automation_runs
          UNION SELECT user_id FROM public.alerts
          UNION SELECT user_id FROM public.audit_log) x
   WHERE u IS NOT NULL;

INSERT INTO public.workspaces (id, name, created_by) SELECT ws, 'Personal workspace', user_id FROM _ws_map;
INSERT INTO public.workspace_members (workspace_id, user_id, role)
  SELECT m.ws, m.user_id, 'owner' FROM _ws_map m JOIN auth.users u ON u.id = m.user_id;

UPDATE public.servers          t SET workspace_id = m.ws FROM _ws_map m WHERE t.user_id = m.user_id;
UPDATE public.automation_tasks t SET workspace_id = m.ws FROM _ws_map m WHERE t.user_id = m.user_id;
UPDATE public.automation_runs  t SET workspace_id = m.ws FROM _ws_map m WHERE t.user_id = m.user_id;
UPDATE public.audit_log        t SET workspace_id = m.ws FROM _ws_map m WHERE t.user_id = m.user_id;
UPDATE public.alerts a SET workspace_id = s.workspace_id FROM public.servers s WHERE s.id = a.server_id;

DROP TABLE _ws_map;

-- Anything that could not be attached (orphans) goes away rather than staying invisible.
DELETE FROM public.alerts WHERE workspace_id IS NULL;
DELETE FROM public.servers WHERE workspace_id IS NULL;
DELETE FROM public.automation_runs WHERE workspace_id IS NULL;
DELETE FROM public.automation_tasks WHERE workspace_id IS NULL;

ALTER TABLE public.servers          ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE public.automation_tasks ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE public.automation_runs  ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE public.alerts           ALTER COLUMN workspace_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS servers_workspace_idx          ON public.servers (workspace_id);
CREATE INDEX IF NOT EXISTS automation_tasks_workspace_idx ON public.automation_tasks (workspace_id);
CREATE INDEX IF NOT EXISTS automation_runs_workspace_idx  ON public.automation_runs (workspace_id);
CREATE INDEX IF NOT EXISTS alerts_workspace_idx           ON public.alerts (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_workspace_idx        ON public.audit_log (workspace_id, created_at DESC);
-- audit history goes away with its workspace; account-level events keep workspace_id NULL
ALTER TABLE public.audit_log ADD FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
ALTER TABLE public.audit_log ALTER COLUMN user_id DROP NOT NULL;

-- Same check, for rows that hang off a server (needs servers.workspace_id, hence defined here).
CREATE OR REPLACE FUNCTION public.server_has_role(sid uuid, min_role text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.servers s
     WHERE s.id = sid AND public.has_role(s.workspace_id, min_role)
  )
$$;

REVOKE ALL ON FUNCTION public.server_has_role(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.server_has_role(uuid, text) TO authenticated, service_role;

-- Creator columns no longer own the data: they become "who did it" and must survive a user leaving.
DO $$
DECLARE t text; c record;
BEGIN
  FOREACH t IN ARRAY ARRAY['servers', 'commands', 'automation_tasks', 'automation_runs', 'task_logs'] LOOP
    FOR c IN SELECT conname FROM pg_constraint
              WHERE conrelid = ('public.' || t)::regclass AND contype = 'f'
                AND confrelid = 'auth.users'::regclass LOOP
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', t, c.conname);
    END LOOP;
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN user_id DROP NOT NULL', t);
    EXECUTE format('ALTER TABLE public.%I ADD FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL', t);
  END LOOP;
END
$$;

-- Alerts belong to the workspace, not a person.
DROP POLICY IF EXISTS "owner select alerts" ON public.alerts;
DROP POLICY IF EXISTS "owner ack alerts" ON public.alerts;
ALTER TABLE public.alerts DROP COLUMN IF EXISTS user_id;

-- ───────────────────────── keep a workspace from losing its last owner ─────────────────────────
CREATE OR REPLACE FUNCTION public.guard_workspace_owner() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE other_owner boolean;
BEGIN
  IF OLD.role <> 'owner' THEN
    RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.role = 'owner' THEN RETURN NEW; END IF;
  -- Workspace itself is being deleted (cascade): allow.
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id = OLD.workspace_id) THEN
    RETURN OLD;
  END IF;
  SELECT EXISTS (SELECT 1 FROM public.workspace_members m
                  WHERE m.workspace_id = OLD.workspace_id AND m.role = 'owner' AND m.user_id <> OLD.user_id)
    INTO other_owner;
  IF NOT other_owner THEN
    RAISE EXCEPTION 'a workspace must keep at least one owner' USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_workspace_owner() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS guard_workspace_owner_trg ON public.workspace_members;
CREATE TRIGGER guard_workspace_owner_trg BEFORE UPDATE OR DELETE ON public.workspace_members
  FOR EACH ROW EXECUTE FUNCTION public.guard_workspace_owner();

-- Servers cannot be moved between workspaces or re-owned from the browser.
CREATE OR REPLACE FUNCTION public.guard_server_token_hash() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.agent_token_hash := OLD.agent_token_hash;
  NEW.user_id := OLD.user_id;
  NEW.workspace_id := OLD.workspace_id;
  RETURN NEW;
END;
$$;

-- ───────────────────────── row-level security ─────────────────────────
ALTER TABLE public.workspaces        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_invites ENABLE ROW LEVEL SECURITY;

-- workspaces / members / invites: read through the API, change only through server routes.
CREATE POLICY "members read workspace"  ON public.workspaces        FOR SELECT TO authenticated USING (public.has_role(id, 'viewer'));
CREATE POLICY "members read members"    ON public.workspace_members  FOR SELECT TO authenticated USING (public.has_role(workspace_id, 'viewer'));
CREATE POLICY "admins read invites"     ON public.workspace_invites  FOR SELECT TO authenticated USING (public.has_role(workspace_id, 'admin'));

-- servers
DROP POLICY IF EXISTS "owner select servers" ON public.servers;
DROP POLICY IF EXISTS "owner update servers" ON public.servers;
DROP POLICY IF EXISTS "owner delete servers" ON public.servers;
CREATE POLICY "viewers read servers"  ON public.servers FOR SELECT TO authenticated USING (public.has_role(workspace_id, 'viewer'));
CREATE POLICY "admins update servers" ON public.servers FOR UPDATE TO authenticated
  USING (public.has_role(workspace_id, 'admin')) WITH CHECK (public.has_role(workspace_id, 'admin'));
CREATE POLICY "admins delete servers" ON public.servers FOR DELETE TO authenticated USING (public.has_role(workspace_id, 'admin'));

-- metrics
DROP POLICY IF EXISTS "owner select metrics" ON public.metrics;
CREATE POLICY "viewers read metrics" ON public.metrics FOR SELECT TO authenticated USING (public.server_has_role(server_id, 'viewer'));

-- commands (may contain secrets in text/output: members and above)
DROP POLICY IF EXISTS "owner select commands" ON public.commands;
DROP POLICY IF EXISTS "owner insert commands" ON public.commands;
DROP POLICY IF EXISTS "owner delete commands" ON public.commands;
CREATE POLICY "members read commands"   ON public.commands FOR SELECT TO authenticated USING (public.server_has_role(server_id, 'member'));
CREATE POLICY "members queue commands"  ON public.commands FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND public.server_has_role(server_id, 'member'));
CREATE POLICY "admins delete commands"  ON public.commands FOR DELETE TO authenticated USING (public.server_has_role(server_id, 'admin'));

-- terminal sessions: a member sees only their own sessions
DROP POLICY IF EXISTS "owner select terminal_sessions" ON public.terminal_sessions;
DROP POLICY IF EXISTS "owner insert terminal_sessions" ON public.terminal_sessions;
DROP POLICY IF EXISTS "owner update terminal_sessions" ON public.terminal_sessions;
DROP POLICY IF EXISTS "owner delete terminal_sessions" ON public.terminal_sessions;
CREATE POLICY "members read own terminal sessions" ON public.terminal_sessions FOR SELECT TO authenticated
  USING (user_id = auth.uid() AND public.server_has_role(server_id, 'member'));

-- playbooks
DROP POLICY IF EXISTS "owner all automation_tasks" ON public.automation_tasks;
CREATE POLICY "viewers read playbooks"  ON public.automation_tasks FOR SELECT TO authenticated USING (public.has_role(workspace_id, 'viewer'));
CREATE POLICY "admins create playbooks" ON public.automation_tasks FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND public.has_role(workspace_id, 'admin'));
CREATE POLICY "admins edit playbooks"   ON public.automation_tasks FOR UPDATE TO authenticated
  USING (public.has_role(workspace_id, 'admin')) WITH CHECK (public.has_role(workspace_id, 'admin'));
CREATE POLICY "admins delete playbooks" ON public.automation_tasks FOR DELETE TO authenticated USING (public.has_role(workspace_id, 'admin'));

-- runs: a run must use a playbook from the SAME workspace
DROP POLICY IF EXISTS "owner all automation_runs" ON public.automation_runs;
CREATE POLICY "members read runs" ON public.automation_runs FOR SELECT TO authenticated USING (public.has_role(workspace_id, 'member'));
CREATE POLICY "members start runs" ON public.automation_runs FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND public.has_role(workspace_id, 'member')
              AND EXISTS (SELECT 1 FROM public.automation_tasks t WHERE t.id = task_id AND t.workspace_id = automation_runs.workspace_id));
CREATE POLICY "members update runs" ON public.automation_runs FOR UPDATE TO authenticated
  USING (public.has_role(workspace_id, 'member')) WITH CHECK (public.has_role(workspace_id, 'member'));
CREATE POLICY "admins delete runs" ON public.automation_runs FOR DELETE TO authenticated USING (public.has_role(workspace_id, 'admin'));

-- task logs: server, run and command must all belong to the same workspace
DROP POLICY IF EXISTS "owner all task_logs" ON public.task_logs;
CREATE POLICY "members read task logs" ON public.task_logs FOR SELECT TO authenticated USING (public.server_has_role(server_id, 'member'));
CREATE POLICY "members write task logs" ON public.task_logs FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid() AND public.server_has_role(server_id, 'member')
    AND EXISTS (SELECT 1 FROM public.automation_runs r JOIN public.servers s ON s.id = task_logs.server_id
                 WHERE r.id = task_logs.run_id AND r.workspace_id = s.workspace_id)
    AND (command_id IS NULL OR EXISTS (SELECT 1 FROM public.commands c WHERE c.id = task_logs.command_id AND c.server_id = task_logs.server_id))
  );
CREATE POLICY "members update task logs" ON public.task_logs FOR UPDATE TO authenticated
  USING (public.server_has_role(server_id, 'member')) WITH CHECK (public.server_has_role(server_id, 'member'));
CREATE POLICY "admins delete task logs" ON public.task_logs FOR DELETE TO authenticated USING (public.server_has_role(server_id, 'admin'));

-- alerts: viewers read, members acknowledge
CREATE POLICY "viewers read alerts" ON public.alerts FOR SELECT TO authenticated USING (public.has_role(workspace_id, 'viewer'));
CREATE POLICY "members ack alerts"  ON public.alerts FOR UPDATE TO authenticated
  USING (public.has_role(workspace_id, 'member')) WITH CHECK (public.has_role(workspace_id, 'member'));

-- audit log: admins read their workspace's log; everyone reads events they caused themselves
DROP POLICY IF EXISTS "owner select audit_log" ON public.audit_log;
CREATE POLICY "read audit log" ON public.audit_log FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR (workspace_id IS NOT NULL AND public.has_role(workspace_id, 'admin')));

-- ───────────────────────── privileges ─────────────────────────
REVOKE ALL ON public.workspaces, public.workspace_members, public.workspace_invites FROM anon, authenticated;
GRANT SELECT ON public.workspaces, public.workspace_members, public.workspace_invites TO authenticated;
GRANT ALL ON public.workspaces, public.workspace_members, public.workspace_invites TO service_role;

-- servers: browser may now also read workspace_id (still never the token hash)
GRANT SELECT (workspace_id) ON public.servers TO authenticated;

-- ───────────────────────── triggers & jobs that referenced owners ─────────────────────────
CREATE OR REPLACE FUNCTION public.audit_command_queued() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.audit_log (user_id, workspace_id, action, target_type, target_id, detail)
  VALUES (NEW.user_id, (SELECT s.workspace_id FROM public.servers s WHERE s.id = NEW.server_id),
          'command.queued', 'server', NEW.server_id,
          jsonb_build_object('command_id', NEW.id, 'command', left(NEW.command, 500)));
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.audit_server_deleted() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor uuid := coalesce(auth.uid(), OLD.user_id);
BEGIN
  -- skip when the whole workspace is going away
  IF actor IS NOT NULL AND EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id = OLD.workspace_id) THEN
    INSERT INTO public.audit_log (user_id, workspace_id, action, target_type, target_id, detail)
    VALUES (actor, OLD.workspace_id, 'server.deleted', 'server', OLD.id, jsonb_build_object('name', left(OLD.name, 100)));
  END IF;
  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION public.evaluate_alerts() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.alerts (workspace_id, server_id, kind, message)
  SELECT s.workspace_id, s.id, 'offline', left(s.name, 100) || ' has stopped reporting'
    FROM public.servers s
   WHERE s.last_seen_at IS NOT NULL AND s.last_seen_at < now() - interval '5 minutes'
  ON CONFLICT (server_id, kind) WHERE resolved_at IS NULL DO NOTHING;

  UPDATE public.alerts a SET resolved_at = now()
    FROM public.servers s
   WHERE a.server_id = s.id AND a.kind = 'offline' AND a.resolved_at IS NULL
     AND s.last_seen_at >= now() - interval '5 minutes';

  WITH latest AS (
    SELECT DISTINCT ON (server_id) server_id, cpu_percent, memory_percent, disk_percent
      FROM public.metrics WHERE recorded_at > now() - interval '5 minutes'
     ORDER BY server_id, recorded_at DESC
  ), breaches AS (
    SELECT server_id, 'cpu'::text AS kind, cpu_percent AS val FROM latest WHERE cpu_percent >= 90
    UNION ALL SELECT server_id, 'memory', memory_percent FROM latest WHERE memory_percent >= 90
    UNION ALL SELECT server_id, 'disk', disk_percent FROM latest WHERE disk_percent >= 90
  )
  INSERT INTO public.alerts (workspace_id, server_id, kind, message)
  SELECT s.workspace_id, b.server_id, b.kind, left(s.name, 100) || ' ' || b.kind || ' usage is at ' || round(b.val) || '%'
    FROM breaches b JOIN public.servers s ON s.id = b.server_id
  ON CONFLICT (server_id, kind) WHERE resolved_at IS NULL DO NOTHING;

  UPDATE public.alerts a SET resolved_at = now()
   WHERE a.resolved_at IS NULL AND a.kind IN ('cpu', 'memory', 'disk')
     AND EXISTS (
       SELECT 1 FROM (
         SELECT DISTINCT ON (server_id) server_id, cpu_percent, memory_percent, disk_percent
           FROM public.metrics WHERE recorded_at > now() - interval '5 minutes'
          ORDER BY server_id, recorded_at DESC
       ) l
        WHERE l.server_id = a.server_id
          AND coalesce(CASE a.kind WHEN 'cpu' THEN l.cpu_percent WHEN 'memory' THEN l.memory_percent ELSE l.disk_percent END, 0) < 80
     );
END;
$$;
