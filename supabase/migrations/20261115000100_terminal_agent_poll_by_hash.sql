-- Agent terminal polling in ONE database round trip including authentication.
-- Previously: look up the server by token hash (1 query), then terminal_agent_poll (1 query).
-- Now the lookup happens inside the same call. Returns NULL for an unknown token.

CREATE OR REPLACE FUNCTION public.terminal_agent_poll_by_hash(p_hash text, p_acks jsonb, p_outputs jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  sid uuid;
BEGIN
  SELECT s.id INTO sid FROM public.servers s WHERE s.agent_token_hash = p_hash;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  RETURN public.terminal_agent_poll(sid, p_acks, p_outputs);
END;
$$;

REVOKE ALL ON FUNCTION public.terminal_agent_poll_by_hash(text, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.terminal_agent_poll_by_hash(text, jsonb, jsonb) TO service_role;
