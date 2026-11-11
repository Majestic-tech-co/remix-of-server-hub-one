-- Store only a SHA-256 hash of each agent token. The raw token is shown once at
-- creation / rotation by the server API and never stored.
-- Servers are now created through /api/servers/create (service role) so the hash
-- is always set server-side; direct client inserts are no longer allowed.

-- 1. Add hash column, backfill from existing plaintext tokens, then drop plaintext.
ALTER TABLE public.servers ADD COLUMN IF NOT EXISTS agent_token_hash text;

UPDATE public.servers
   SET agent_token_hash = encode(sha256(convert_to(agent_token, 'UTF8')), 'hex')
 WHERE agent_token_hash IS NULL AND agent_token IS NOT NULL;

ALTER TABLE public.servers ALTER COLUMN agent_token_hash SET NOT NULL;
ALTER TABLE public.servers DROP CONSTRAINT IF EXISTS servers_agent_token_hash_key;
ALTER TABLE public.servers ADD CONSTRAINT servers_agent_token_hash_key UNIQUE (agent_token_hash);

DROP TRIGGER IF EXISTS prevent_agent_token_change_trg ON public.servers;
DROP FUNCTION IF EXISTS public.prevent_agent_token_change();
ALTER TABLE public.servers DROP COLUMN IF EXISTS agent_token;

-- 2. Clients can no longer insert servers directly, or change the hash.
DROP POLICY IF EXISTS "owner insert servers" ON public.servers;

CREATE OR REPLACE FUNCTION public.guard_server_token_hash()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.agent_token_hash := OLD.agent_token_hash;
  NEW.user_id := OLD.user_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_server_token_hash_trg ON public.servers;
CREATE TRIGGER guard_server_token_hash_trg
  BEFORE UPDATE ON public.servers
  FOR EACH ROW
  WHEN (current_setting('role', true) <> 'service_role')
  EXECUTE FUNCTION public.guard_server_token_hash();

-- 3. Keep the hash out of the browser: column-level privileges for signed-in users.
REVOKE SELECT ON public.servers FROM authenticated;
GRANT SELECT (id, user_id, name, hostname, ip_address, os, tags, last_seen_at, created_at,
              type, region, instance_id, connection_notes)
  ON public.servers TO authenticated;
