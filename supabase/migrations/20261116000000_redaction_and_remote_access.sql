-- 1. Secrets are scrubbed from the AUDIT copy of every command.
-- 2. Per-server "remote access" switch: when off, a server is monitoring-only (no commands, no terminals).

-- ───────────────────────── 1. redaction ─────────────────────────
-- The commands table keeps the real command (it has to run). The audit log keeps a copy for a year, so
-- obvious secrets are replaced with [redacted] before that copy is written. Best effort, not a guarantee:
-- don't type secrets into commands.
CREATE OR REPLACE FUNCTION public.redact_command(c text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $fn$
DECLARE r text := c;
BEGIN
  IF r IS NULL THEN RETURN NULL; END IF;
  -- private key blocks
  -- (Postgres makes the WHOLE expression prefer the shortest or longest match depending on its FIRST repetition,
  -- so every repetition here is lazy to stop at the first END marker instead of running to the end.)
  r := regexp_replace(r, $re$-----BEGIN [A-Z ]*?PRIVATE KEY-----.*?(-----END [A-Z ]*?PRIVATE KEY-----|$)$re$, $rp$[redacted private key]$rp$, 'g');
  -- Authorization / API-key headers
  r := regexp_replace(r, $re$(authorization:\s*(bearer|basic|token)\s+)\S+$re$, $rp$\1[redacted]$rp$, 'gi');
  r := regexp_replace(r, $re$(x-api-key:\s*)\S+$re$, $rp$\1[redacted]$rp$, 'gi');
  -- credentials inside URLs: scheme://user:password@host
  r := regexp_replace(r, $re$([a-z][a-z0-9+.-]*://[^\s:/@]+:)[^\s@/]+(@)$re$, $rp$\1[redacted]\2$rp$, 'gi');
  -- curl -u user:password, --user user:password
  r := regexp_replace(r, $re$(\s(-u|--user)[\s=]+[^\s:]+:)\S+$re$, $rp$\1[redacted]$rp$, 'gi');
  -- sshpass -p secret
  r := regexp_replace(r, $re$(sshpass\s+-p\s+)\S+$re$, $rp$\1[redacted]$rp$, 'gi');
  -- mysql -uroot -pSECRET (only when it is a mysql/mariadb command, so "mkdir -p dir" is untouched)
  r := regexp_replace(r, $re$((^|\s)(mysql|mariadb)\w*?(\s[^|;&]*?)?\s-p)\S+$re$, $rp$\1[redacted]$rp$, 'gi');
  -- NAME=value / name: value where the name looks secret (password, token, api key, ...)
  r := regexp_replace(r, $re$([A-Za-z0-9_.-]*(pass(word|wd)?|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)[A-Za-z0-9_.-]*\s*[=:]\s*)('[^']*'|"[^"]*"|\S+)$re$, $rp$\1[redacted]$rp$, 'gi');
  -- --password value / --token value (space separated)
  r := regexp_replace(r, $re$(--?(pass(word|wd)?|secret|token|api[_-]?key)\s+)('[^']*'|"[^"]*"|[^\s-]\S*)$re$, $rp$\1[redacted]$rp$, 'gi');
  -- well-known token formats
  r := regexp_replace(r, $re$\yAKIA[0-9A-Z]{16}\y$re$, $rp$[redacted-aws-key]$rp$, 'g');
  r := regexp_replace(r, $re$\ygh[pousr]_[A-Za-z0-9]{20,}\y$re$, $rp$[redacted-token]$rp$, 'g');
  r := regexp_replace(r, $re$\yxox[abprs]-[A-Za-z0-9-]{10,}$re$, $rp$[redacted-token]$rp$, 'g');
  r := regexp_replace(r, $re$\ysk-[A-Za-z0-9_-]{20,}$re$, $rp$[redacted-token]$rp$, 'g');
  r := regexp_replace(r, $re$\y[rs]k_(live|test)_[A-Za-z0-9]{10,}$re$, $rp$[redacted-token]$rp$, 'g');
  r := regexp_replace(r, $re$eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$re$, $rp$[redacted-jwt]$rp$, 'g');
  RETURN r;
END;
$fn$;
REVOKE ALL ON FUNCTION public.redact_command(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.audit_command_queued() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.audit_log (user_id, workspace_id, action, target_type, target_id, detail)
  VALUES (NEW.user_id, (SELECT s.workspace_id FROM public.servers s WHERE s.id = NEW.server_id),
          'command.queued', 'server', NEW.server_id,
          jsonb_build_object('command_id', NEW.id, 'command', left(public.redact_command(NEW.command), 500)));
  RETURN NEW;
END;
$$;

-- clean up what was already recorded
UPDATE public.audit_log
   SET detail = jsonb_set(detail, '{command}', to_jsonb(left(public.redact_command(detail ->> 'command'), 500)))
 WHERE action = 'command.queued' AND detail ? 'command';

-- ───────────────────────── 2. remote access switch ─────────────────────────
ALTER TABLE public.servers ADD COLUMN IF NOT EXISTS remote_access boolean NOT NULL DEFAULT true;
GRANT SELECT (remote_access) ON public.servers TO authenticated;
GRANT UPDATE (remote_access) ON public.servers TO authenticated;   -- changing a row still needs the admin UPDATE policy

-- no commands can be queued against a monitoring-only server (members+ otherwise)
DROP POLICY IF EXISTS "members queue commands" ON public.commands;
CREATE POLICY "members queue commands" ON public.commands FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND public.server_has_role(server_id, 'member')
    AND EXISTS (SELECT 1 FROM public.servers s WHERE s.id = commands.server_id AND s.remote_access)
  );

-- turning it off: record who did it, cancel commands that haven't started, close open terminals
CREATE OR REPLACE FUNCTION public.servers_remote_access_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.audit_log (user_id, workspace_id, action, target_type, target_id, detail)
  VALUES (coalesce(auth.uid(), NEW.user_id), NEW.workspace_id,
          CASE WHEN NEW.remote_access THEN 'server.remote_enabled' ELSE 'server.remote_disabled' END,
          'server', NEW.id, jsonb_build_object('name', left(NEW.name, 100)));
  IF NOT NEW.remote_access THEN
    UPDATE public.commands
       SET status = 'failed', exit_code = coalesce(exit_code, -1),
           stderr = coalesce(stderr, '') || E'\n[fleet] cancelled: remote commands were turned off for this server',
           completed_at = now()
     WHERE server_id = NEW.id AND status = 'pending';
    UPDATE public.terminal_sessions SET status = 'closed', closed_at = now()
     WHERE server_id = NEW.id AND status IN ('requested', 'active');
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.servers_remote_access_changed() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS servers_remote_access_changed_trg ON public.servers;
CREATE TRIGGER servers_remote_access_changed_trg AFTER UPDATE OF remote_access ON public.servers
  FOR EACH ROW WHEN (OLD.remote_access IS DISTINCT FROM NEW.remote_access)
  EXECUTE FUNCTION public.servers_remote_access_changed();

-- the agent asks for work: monitoring-only servers get none. One atomic call (replaces select + update).
CREATE OR REPLACE FUNCTION public.claim_commands(p_server uuid, p_limit integer)
RETURNS TABLE (id uuid, command text)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  WITH c AS (
    SELECT cm.id FROM public.commands cm
     WHERE cm.server_id = p_server AND cm.status = 'pending'
       AND EXISTS (SELECT 1 FROM public.servers s WHERE s.id = p_server AND s.remote_access)
     ORDER BY cm.created_at
     LIMIT greatest(1, least(p_limit, 20))
       FOR UPDATE SKIP LOCKED
  )
  UPDATE public.commands cm SET status = 'running', started_at = now()
    FROM c WHERE cm.id = c.id
  RETURNING cm.id, cm.command
$$;
REVOKE ALL ON FUNCTION public.claim_commands(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_commands(uuid, integer) TO service_role;

-- the terminal agent poll (unchanged apart from step 1b)
CREATE OR REPLACE FUNCTION public.terminal_agent_poll(p_server uuid, p_acks jsonb, p_outputs jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  ts timestamptz := now();
  k text;
  v bigint;
  sid uuid;
  o jsonb;
  chunk text;
  s public.terminal_sessions%ROWTYPE;
  nb text;
  cut integer;
  nl integer;
  max_out constant integer := 1000000;
  result jsonb;
BEGIN
  -- 1. close sessions whose browser went away
  UPDATE public.terminal_sessions t SET status = 'closed', closed_at = ts
   WHERE t.server_id = p_server AND t.status IN ('requested', 'active')
     AND t.last_client_poll_at < ts - interval '5 minutes';

  -- 1b. monitoring-only servers: no terminal may stay open (the agent is told to kill the shell)
  UPDATE public.terminal_sessions t SET status = 'closed', closed_at = ts
   WHERE t.server_id = p_server AND t.status IN ('requested', 'active')
     AND NOT EXISTS (SELECT 1 FROM public.servers sv WHERE sv.id = p_server AND sv.remote_access);

  -- 2. keystrokes the agent has written to the shell: drop them from the buffer
  IF p_acks IS NOT NULL AND jsonb_typeof(p_acks) = 'object' THEN
    FOR k, v IN SELECT key, value::bigint FROM jsonb_each_text(p_acks) LOOP
      IF v <= 0 THEN CONTINUE; END IF;
      BEGIN sid := k::uuid; EXCEPTION WHEN others THEN CONTINUE; END;
      UPDATE public.terminal_sessions t SET
        input_buffer = substr(t.input_buffer, least(v, length(t.input_buffer)::bigint)::integer + 1),
        agent_input_ack = coalesce(t.agent_input_ack, 0) + least(v, length(t.input_buffer)::bigint)
       WHERE t.id = sid AND t.server_id = p_server;
    END LOOP;
  END IF;

  -- 3. shell output: append one chunk per line; if over the cap drop whole chunks from the front
  IF p_outputs IS NOT NULL AND jsonb_typeof(p_outputs) = 'array' THEN
    FOR o IN SELECT * FROM jsonb_array_elements(p_outputs) LOOP
      BEGIN sid := (o ->> 'session_id')::uuid; EXCEPTION WHEN others THEN CONTINUE; END;
      chunk := o ->> 'b64';
      IF chunk IS NULL OR chunk = '' THEN CONTINUE; END IF;
      SELECT * INTO s FROM public.terminal_sessions t
       WHERE t.id = sid AND t.server_id = p_server AND t.status <> 'closed' FOR UPDATE;
      IF NOT FOUND THEN CONTINUE; END IF;

      nb := s.output_buffer || chunk || E'\n';
      cut := 0;
      IF length(nb) > max_out THEN
        cut := length(nb) - max_out;
        nl := position(E'\n' in substr(nb, cut + 1));
        cut := CASE WHEN nl = 0 THEN length(nb) ELSE cut + nl END;
        nb := substr(nb, cut + 1);
      END IF;
      UPDATE public.terminal_sessions t SET
        output_buffer = nb,
        output_seq = t.output_seq + length(chunk) + 1,
        client_output_ack = t.client_output_ack + cut
       WHERE t.id = s.id;
    END LOOP;
  END IF;

  -- 4. the agent is alive: promote newly requested sessions, stamp the poll
  UPDATE public.terminal_sessions t SET last_agent_poll_at = ts, status = 'active'
   WHERE t.server_id = p_server AND t.status = 'requested';
  UPDATE public.terminal_sessions t SET last_agent_poll_at = ts
   WHERE t.server_id = p_server AND t.status = 'active';

  -- 5. what the agent should do now. Recently closed sessions are included so it can kill their shells.
  SELECT jsonb_build_object(
           'sessions', coalesce(jsonb_agg(jsonb_build_object(
               'id', t.id, 'status', t.status, 'cols', t.cols, 'rows', t.rows, 'input_b64', t.input_buffer
             ) ORDER BY t.created_at) FILTER (
               WHERE t.status <> 'closed' OR length(t.input_buffer) > 0 OR t.closed_at > ts - interval '10 minutes'
             ), '[]'::jsonb),
           'closed', coalesce(jsonb_agg(t.id) FILTER (WHERE t.status = 'closed' AND t.closed_at > ts - interval '10 minutes'), '[]'::jsonb)
         )
    INTO result
    FROM public.terminal_sessions t
   WHERE t.server_id = p_server AND (t.status <> 'closed' OR t.closed_at > ts - interval '10 minutes');

  RETURN coalesce(result, jsonb_build_object('sessions', '[]'::jsonb, 'closed', '[]'::jsonb));
END;
$$;

REVOKE ALL ON FUNCTION public.terminal_agent_poll(uuid, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.terminal_agent_poll(uuid, jsonb, jsonb) TO service_role;
