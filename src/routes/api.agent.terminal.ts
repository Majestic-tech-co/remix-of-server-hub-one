// POST /api/agent/terminal
// Headers: X-Fleet-Token: <agent_token>
// Body: {
//   acks?: { [session_id]: chars_consumed_from_input_buffer },
//   outputs?: [{ session_id, b64 }],   // PTY output chunk (one base64 string per entry)
// }
// Response: { sessions: [{ id, status, cols, rows, input_b64 }], closed: [session_id] }
//   input_b64 holds one base64 chunk per line; the agent decodes line by line.
//
// One round-trip per agent poll and ONE database call that also authenticates the token
// (terminal_agent_poll_by_hash). Sessions auto-close after 5 min without a browser poll.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { clientIp, errors, json, logServerError, rateLimit, sha256Hex, shortHash } from "@/lib/security.server";

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
          // Same protections as authenticateAgent(), but the token lookup happens inside the RPC.
          const ip = clientIp(request);
          const ipCheck = rateLimit(`agent-ip:${ip}`, 3000, 60_000);
          if (!ipCheck.ok) return errors.tooMany(ipCheck.retryAfter);
          const token = request.headers.get("x-fleet-token");
          if (!token || token.length > 128) return errors.unauthorized();
          const rl = rateLimit(`agent-token:${shortHash(token)}`, 1800, 60_000);
          if (!rl.ok) return errors.tooMany(rl.retryAfter);

          let body: unknown = {};
          try {
            const text = await request.text();
            if (text.length > 2_000_000) return errors.badRequest();
            if (text) body = JSON.parse(text);
          } catch { return errors.badRequest(); }
          const parsed = Schema.safeParse(body);
          if (!parsed.success) return errors.badRequest();

          const { data, error } = await supabaseAdmin.rpc("terminal_agent_poll_by_hash", {
            p_hash: await sha256Hex(token),
            p_acks: parsed.data.acks ?? {},
            p_outputs: parsed.data.outputs ?? [],
          });
          if (error) { logServerError("agent-terminal", error); return errors.server(); }
          if (data === null) {
            // unknown token: penalise guessing harder
            const bad = rateLimit(`agent-bad:${ip}`, 20, 60_000);
            if (!bad.ok) return errors.tooMany(bad.retryAfter);
            return errors.unauthorized();
          }
          return json(data);
        } catch (e) {
          logServerError("agent-terminal", e);
          return errors.server();
        }
      },
    },
  },
});
