-- Server details: the agent reports what is running (services, containers, top processes) about once a minute.
-- One row per server, replaced each time. Only the agent (through the site, with service-role) writes it.
-- Team viewers and up can read it. It holds names and numbers only, never command lines or environment.

CREATE TABLE IF NOT EXISTS public.server_snapshots (
  server_id    uuid PRIMARY KEY REFERENCES public.servers(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  data         jsonb NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT snapshot_is_object CHECK (jsonb_typeof(data) = 'object'),
  CONSTRAINT snapshot_size      CHECK (pg_column_size(data) <= 200000)
);

-- Keep workspace_id in step with the server it belongs to (nobody can claim a server of another team).
CREATE OR REPLACE FUNCTION public.snapshot_set_workspace() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  SELECT workspace_id INTO NEW.workspace_id FROM public.servers WHERE id = NEW.server_id;
  IF NEW.workspace_id IS NULL THEN RAISE EXCEPTION 'server not found'; END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.snapshot_set_workspace() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS snapshot_set_workspace_trg ON public.server_snapshots;
CREATE TRIGGER snapshot_set_workspace_trg BEFORE INSERT OR UPDATE ON public.server_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.snapshot_set_workspace();

ALTER TABLE public.server_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "viewers read snapshots" ON public.server_snapshots;
CREATE POLICY "viewers read snapshots" ON public.server_snapshots FOR SELECT TO authenticated
  USING (public.server_has_role(server_id, 'viewer'));

REVOKE ALL ON public.server_snapshots FROM anon, authenticated;
GRANT SELECT ON public.server_snapshots TO authenticated;
GRANT ALL ON public.server_snapshots TO service_role;
