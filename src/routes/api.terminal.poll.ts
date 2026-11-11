// POST /api/terminal/poll
// Browser auth. Body: { session_id, output_ack, input_b64?, cols?, rows?, close? }
// One call that (optionally) appends typed bytes, resizes, closes, and returns any new output since
// the last acknowledgement. ONE database round trip (terminal_client_poll); the membership check is
// cached for a few seconds so it doesn't add queries to every keystroke.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getUserFromRequest } from "@/integrations/supabase/route-auth";
import { checkTerminalAccess, errors, json, logServerError, rateLimit } from "@/lib/security.server";

const Schema = z.object({
  session_id: z.string().uuid(),
  output_ack: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  // one base64 chunk; no newlines (newline is the framing character in the stored buffer)
  input_b64: z.string().max(64_000).regex(/^[A-Za-z0-9+/=]*$/).optional(),
  cols: z.number().int().min(20).max(500).optional(),
  rows: z.number().int().min(5).max(200).optional(),
  close: z.boolean().optional(),
}).strict();

export const Route = createFileRoute("/api/terminal/poll")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const auth = await getUserFromRequest(request);
          if (auth instanceof Response) return auth;
          const rl = rateLimit(`term-poll:${auth.userId}`, 1200, 60_000);
          if (!rl.ok) return errors.tooMany(rl.retryAfter);

          let body: unknown;
          try { body = await request.json(); } catch { return errors.badRequest(); }
          const parsed = Schema.safeParse(body);
          if (!parsed.success) return errors.badRequest();
          const d = parsed.data;

          // Must still be a member (or above) of the server's workspace. Removing someone or
          // demoting them to viewer cuts off an open shell within a few seconds.
          if (!(await checkTerminalAccess(supabaseAdmin, auth.userId, d.session_id))) {
            await supabaseAdmin
              .from("terminal_sessions")
              .update({ status: "closed", closed_at: new Date().toISOString() })
              .eq("id", d.session_id).eq("user_id", auth.userId).neq("status", "closed");
            return errors.notFound();
          }

          const { data, error } = await supabaseAdmin.rpc("terminal_client_poll", {
            p_session: d.session_id,
            p_user: auth.userId,
            p_output_ack: d.output_ack,
            p_input: d.input_b64 ?? "",
            p_cols: d.cols ?? null,
            p_rows: d.rows ?? null,
            p_close: d.close ?? false,
          });
          if (error) { logServerError("terminal-poll", error); return errors.server(); }
          const row = data?.[0];
          if (!row?.r_found) return errors.notFound();

          return json({
            status: row.r_status,
            output_b64: row.r_output,
            output_seq: row.r_seq,
            cols: row.r_cols,
            rows: row.r_rows,
          });
        } catch (e) {
          logServerError("terminal-poll", e);
          return errors.server();
        }
      },
    },
  },
});
