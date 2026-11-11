// POST /api/agent/terminal
// Headers: X-Fleet-Token: <agent_token>
// Body: {
//   acks?: { [session_id]: chars_consumed_from_input_buffer },
//   outputs?: [{ session_id, b64 }],   // PTY output chunk (one base64 string per entry)
// }
// Response: { sessions: [{ id, status, cols, rows, input_b64 }], closed: [session_id] }
//   input_b64 holds one base64 chunk per line; the agent decodes line by line.
//
// One round-trip per agent poll, ONE database call (terminal_agent_poll). Sessions auto-close after
// 5 min without a browser poll.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { authenticateAgent, errors, json, logServerError } from "@/lib/security.server";

const Schema = z.object({
  acks: z.record(z.string().uuid(), z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)).optional(),
  outputs: z.array(z.object({
    session_id: z.string().uuid(),
    // No newlines allowed: a newline is the framing character between chunks.
    b64: z.string().max(200_000).regex(/^[A-Za-z0-9+/=]*$/),
  })).max(20).optional(),
}).strict();

export const Route = createFileRoute("/api/agent/terminal")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const auth = await authenticateAgent(request, supabaseAdmin, { limit: 1200 });
          if (auth instanceof Response) return auth;

          let body: unknown = {};
          try {
            const text = await request.text();
            if (text.length > 2_000_000) return errors.badRequest();
            if (text) body = JSON.parse(text);
          } catch { return errors.badRequest(); }
          const parsed = Schema.safeParse(body);
          if (!parsed.success) return errors.badRequest();

          const { data, error } = await supabaseAdmin.rpc("terminal_agent_poll", {
            p_server: auth.serverId,
            p_acks: parsed.data.acks ?? {},
            p_outputs: parsed.data.outputs ?? [],
          });
          if (error) { logServerError("agent-terminal", error); return errors.server(); }
          return json(data);
        } catch (e) {
          logServerError("agent-terminal", e);
          return errors.server();
        }
      },
    },
  },
});
