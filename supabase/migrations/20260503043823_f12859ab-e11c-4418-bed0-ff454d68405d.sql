
-- 1. servers: prevent agent_token tampering and add WITH CHECK
DROP POLICY IF EXISTS "owner update servers" ON public.servers;
CREATE POLICY "owner update servers" ON public.servers
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.prevent_agent_token_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.agent_token IS DISTINCT FROM OLD.agent_token THEN
    NEW.agent_token := OLD.agent_token;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS prevent_agent_token_change_trg ON public.servers;
CREATE TRIGGER prevent_agent_token_change_trg
  BEFORE UPDATE ON public.servers
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_agent_token_change();

-- 2. commands: explicitly deny client-side updates (agent writes via service role)
CREATE POLICY "no client update commands" ON public.commands
  FOR UPDATE
  USING (false)
  WITH CHECK (false);

-- 3. metrics: explicitly deny client-side writes (agent writes via service role)
CREATE POLICY "no client insert metrics" ON public.metrics
  FOR INSERT
  WITH CHECK (false);

CREATE POLICY "no client update metrics" ON public.metrics
  FOR UPDATE
  USING (false)
  WITH CHECK (false);

CREATE POLICY "no client delete metrics" ON public.metrics
  FOR DELETE
  USING (false);

-- 4. Revoke anonymous (signed-out) access to these tables via PostgREST/GraphQL
REVOKE ALL ON public.servers FROM anon;
REVOKE ALL ON public.commands FROM anon;
REVOKE ALL ON public.metrics FROM anon;
