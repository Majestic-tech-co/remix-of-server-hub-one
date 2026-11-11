-- Terminal polling in ONE database round trip per poll (was 6–10 sequential queries each), and
-- fixes two protocol bugs:
--
--   1. Framing. Browser and agent exchange base64 chunks through text buffers. Chunks were simply
--      concatenated, but base64 padding in the middle of a string breaks decoding: the Python agent
--      silently kept only the FIRST chunk (typed characters vanished) and the browser's atob()
--      threw (terminal froze). Both buffers now hold one chunk per line ('\n' terminated); the
--      reader decodes line by line.
--   2. Atomicity. Read-modify-write from two request handlers could replay or lose keystrokes.
--      Each function now locks the session row (FOR UPDATE) and does everything in one statement
--      sequence.
--
-- Callable by the server (service role) only; ownership/role checks stay in the API routes.

CREATE OR REPLACE FUNCTION public.terminal_client_poll(
  p_session uuid, p_user uuid, p_output_ack bigint, p_input text,
  p_cols integer, p_rows integer, p_close boolean
) RETURNS TABLE (r_found boolean, r_status text, r_output text, r_seq bigint, r_cols integer, r_rows integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s public.terminal_sessions%ROWTYPE;
  ts timestamptz := now();
  new_in text;
  new_in_seq bigint;
  skip integer;
  slice text;
  new_ack bigint;
  new_status public.terminal_session_status;
  max_in constant integer := 256000;
BEGIN
  SELECT * INTO s FROM public.terminal_sessions t WHERE t.id = p_session AND t.user_id = p_user FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, ''::text, ''::text, 0::bigint, 0, 0;
    RETURN;
  END IF;

  new_status := CASE WHEN p_close THEN 'closed'::public.terminal_session_status ELSE s.status END;

  -- keystrokes: append one chunk per line, keep only whole chunks if the cap is hit
  new_in := s.input_buffer;
  new_in_seq := s.input_seq;
  IF p_input IS NOT NULL AND length(p_input) > 0 AND s.status <> 'closed' THEN
    new_in := new_in || p_input || E'\n';
    IF length(new_in) > max_in THEN
      new_in := right(new_in, max_in);
      new_in := substr(new_in, position(E'\n' in new_in) + 1);
    END IF;
    new_in_seq := new_in_seq + 1;
  END IF;

  -- output: everything after what the browser has acknowledged
  skip := least(greatest(p_output_ack - s.client_output_ack, 0), length(s.output_buffer)::bigint)::integer;
  slice := substr(s.output_buffer, skip + 1);
  new_ack := s.client_output_ack + skip;

  UPDATE public.terminal_sessions t SET
    status = new_status,
    closed_at = CASE WHEN p_close AND s.status <> 'closed' THEN ts ELSE t.closed_at END,
    cols = coalesce(p_cols, t.cols),
    rows = coalesce(p_rows, t.rows),
    input_buffer = new_in,
    input_seq = new_in_seq,
    output_buffer = slice,
    client_output_ack = new_ack,
    last_client_poll_at = ts
  WHERE t.id = s.id;

  RETURN QUERY SELECT true, new_status::text, slice, s.output_seq, coalesce(p_cols, s.cols), coalesce(p_rows, s.rows);
END;
$$;

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

REVOKE ALL ON FUNCTION public.terminal_client_poll(uuid, uuid, bigint, text, integer, integer, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.terminal_agent_poll(uuid, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.terminal_client_poll(uuid, uuid, bigint, text, integer, integer, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.terminal_agent_poll(uuid, jsonb, jsonb) TO service_role;
