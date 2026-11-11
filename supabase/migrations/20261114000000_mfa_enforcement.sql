-- Two-factor (TOTP) enforcement at the database.
--
-- 1. Anyone who has a VERIFIED authenticator factor must present an aal2 session (i.e. have entered
--    a code) to read or write any workspace data. A stolen password alone, used straight against the
--    API, gets nothing. Users without a factor are unaffected.
-- 2. A workspace can require two-factor from all its members: a member without a verified factor
--    gets no access to that workspace until they set one up.

ALTER TABLE public.workspaces ADD COLUMN IF NOT EXISTS require_mfa boolean NOT NULL DEFAULT false;

-- These helpers run once per row inside row-level-security checks, so they are written as single
-- plpgsql bodies with ONE lookup each and no nested SECURITY DEFINER calls (each such call costs a
-- context switch; nesting five of them per row was measurably slow).
CREATE OR REPLACE FUNCTION public.has_verified_mfa() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN EXISTS (SELECT 1 FROM auth.mfa_factors f WHERE f.user_id = auth.uid() AND f.status::text = 'verified');
END;
$$;

-- True if the session is fully verified, or the user has no second factor to verify.
CREATE OR REPLACE FUNCTION public.mfa_ok() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2' THEN RETURN true; END IF;
  RETURN NOT EXISTS (SELECT 1 FROM auth.mfa_factors f WHERE f.user_id = auth.uid() AND f.status::text = 'verified');
END;
$$;

REVOKE ALL ON FUNCTION public.has_verified_mfa(), public.mfa_ok() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_verified_mfa(), public.mfa_ok() TO authenticated, service_role;

-- Every workspace-scoped policy goes through has_role(); the 2FA rules live here so they cover them all:
--   * a user with a verified factor needs an aal2 session (a code was entered) for ANY access
--   * a workspace with require_mfa denies members who have no verified factor
CREATE OR REPLACE FUNCTION public.has_role(ws uuid, min_role text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  uid uuid := auth.uid();
  verified boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM auth.mfa_factors f WHERE f.user_id = uid AND f.status::text = 'verified') INTO verified;
  IF verified AND coalesce(auth.jwt() ->> 'aal', 'aal1') <> 'aal2' THEN RETURN false; END IF;
  RETURN EXISTS (
    SELECT 1
      FROM public.workspace_members m
      JOIN public.workspaces w ON w.id = m.workspace_id
     WHERE m.workspace_id = ws AND m.user_id = uid
       AND public.role_rank(m.role) >= public.role_rank(min_role)
       AND (verified OR NOT w.require_mfa)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.server_has_role(sid uuid, min_role text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN EXISTS (SELECT 1 FROM public.servers s WHERE s.id = sid AND public.has_role(s.workspace_id, min_role));
END;
$$;

-- The two policies that also grant access by "this is my own row" need the check too.
DROP POLICY IF EXISTS "read audit log" ON public.audit_log;
CREATE POLICY "read audit log" ON public.audit_log FOR SELECT TO authenticated
  USING (public.mfa_ok() AND (user_id = auth.uid() OR (workspace_id IS NOT NULL AND public.has_role(workspace_id, 'admin'))));

DROP POLICY IF EXISTS "members read own terminal sessions" ON public.terminal_sessions;
CREATE POLICY "members read own terminal sessions" ON public.terminal_sessions FOR SELECT TO authenticated
  USING (public.mfa_ok() AND user_id = auth.uid() AND public.server_has_role(server_id, 'member'));

-- Owners switch the requirement on/off through the API only (it checks the owner has 2FA themselves).
-- Browser access to the new column stays read-only via the existing SELECT-only grant on workspaces.
