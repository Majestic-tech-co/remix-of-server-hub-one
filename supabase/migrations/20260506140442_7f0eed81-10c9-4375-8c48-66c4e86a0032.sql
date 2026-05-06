CREATE TYPE public.terminal_session_status AS ENUM ('requested', 'active', 'closed');

CREATE TABLE public.terminal_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id uuid NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  status public.terminal_session_status NOT NULL DEFAULT 'requested',
  cols integer NOT NULL DEFAULT 80,
  rows integer NOT NULL DEFAULT 24,
  input_buffer text NOT NULL DEFAULT '',
  output_buffer text NOT NULL DEFAULT '',
  input_seq bigint NOT NULL DEFAULT 0,
  output_seq bigint NOT NULL DEFAULT 0,
  agent_input_ack bigint NOT NULL DEFAULT 0,
  client_output_ack bigint NOT NULL DEFAULT 0,
  last_client_poll_at timestamptz NOT NULL DEFAULT now(),
  last_agent_poll_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);

CREATE INDEX idx_terminal_sessions_server_status ON public.terminal_sessions(server_id, status);
CREATE INDEX idx_terminal_sessions_user ON public.terminal_sessions(user_id, created_at DESC);

ALTER TABLE public.terminal_sessions ENABLE ROW LEVEL SECURITY;

-- Owner can see their own sessions
CREATE POLICY "owner select terminal_sessions"
  ON public.terminal_sessions FOR SELECT
  USING (auth.uid() = user_id);

-- Owner can create a session for their own server
CREATE POLICY "owner insert terminal_sessions"
  ON public.terminal_sessions FOR INSERT
  WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (SELECT 1 FROM public.servers s WHERE s.id = server_id AND s.user_id = auth.uid())
  );

-- Owner can update only safe fields (status close, input append, ack, resize) — service role bypasses anyway.
-- We allow update; a trigger guards immutable columns.
CREATE POLICY "owner update terminal_sessions"
  ON public.terminal_sessions FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "owner delete terminal_sessions"
  ON public.terminal_sessions FOR DELETE
  USING (auth.uid() = user_id);

-- Guard immutable fields from client tampering (service role bypasses RLS so it's unaffected)
CREATE OR REPLACE FUNCTION public.guard_terminal_session_updates()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Identity / ownership cannot change
  NEW.id := OLD.id;
  NEW.server_id := OLD.server_id;
  NEW.user_id := OLD.user_id;
  NEW.created_at := OLD.created_at;
  -- Output buffer is agent-only; revert any client edits
  NEW.output_buffer := OLD.output_buffer;
  NEW.output_seq := OLD.output_seq;
  NEW.agent_input_ack := OLD.agent_input_ack;
  NEW.last_agent_poll_at := OLD.last_agent_poll_at;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_terminal_session_updates
  BEFORE UPDATE ON public.terminal_sessions
  FOR EACH ROW
  WHEN (current_setting('role', true) <> 'service_role')
  EXECUTE FUNCTION public.guard_terminal_session_updates();