
CREATE OR REPLACE FUNCTION public.prevent_agent_token_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF NEW.agent_token IS DISTINCT FROM OLD.agent_token THEN
    NEW.agent_token := OLD.agent_token;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.prevent_agent_token_change() FROM PUBLIC, anon, authenticated;
