// POST /api/agent/terminal
// Headers: X-Fleet-Token: <agent_token>
// Body: {
//   acks?: { [session_id]: bytes_consumed_from_input_buffer },
//   outputs?: [{ session_id, b64 }],   // PTY output to append
// }
// Response: {
//   sessions: [{ id, status, cols, rows, input_b64 }]
// }
//
// One round-trip per agent poll: report consumed input, push new output,
// receive every active session's pending input + size + status. Sessions
// auto-time-out after 5 min without a browser poll.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { authenticateAgent, errors, json, logServerError } from "@/lib/security.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const Schema = z.object({
  acks: z.record(z.string().uuid(), z.number().int().min(0)).optional(),
  outputs: z.array(z.object({
    session_id: z.string().uuid(),
    b64: z.string().max(200_000).regex(/^[A-Za-z0-9+\/=\r\n]*$/),
  })).max(20).optional(),
});


const MAX_OUTPUT_BUFFER = 1_000_000; // 1MB rolling cap
const SESSION_IDLE_MS = 5 * 60 * 1000;

export const Route = createFileRoute("/api/agent/terminal")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = await authenticateAgent(request, supabaseAdmin, { limit: 900 });
        if (auth instanceof Response) return auth;
        const srv = { id: auth.serverId };
        try {
        let body: unknown = {};
        try {
          const text = await request.text();
          if (text.length > 2_000_000) return errors.badRequest();
          if (text) body = JSON.parse(text);
        } catch { return errors.badRequest(); }
        const parsed = Schema.safeParse(body);
        if (!parsed.success) return errors.badRequest();
        const data = parsed.data;

        const now = new Date();
        const idleCutoff = new Date(now.getTime() - SESSION_IDLE_MS).toISOString();

        // 1. Auto-close idle sessions for this server
        await supabaseAdmin
          .from("terminal_sessions")
          .update({ status: "closed", closed_at: now.toISOString() })
          .eq("server_id", srv.id)
          .in("status", ["requested", "active"])
          .lt("last_client_poll_at", idleCutoff);

        // 2. Apply acks (consume bytes from input_buffer)
        if (data.acks) {
          for (const [sid, bytes] of Object.entries(data.acks)) {
            if (!bytes) continue;
            const { data: s } = await supabaseAdmin
              .from("terminal_sessions")
              .select("id, input_buffer, agent_input_ack, server_id")
              .eq("id", sid)
              .single();
            if (!s || s.server_id !== srv.id) continue;
            const buf = s.input_buffer || "";
            const consumed = Math.min(bytes, buf.length);
            await supabaseAdmin
              .from("terminal_sessions")
              .update({
                input_buffer: buf.slice(consumed),
                agent_input_ack: (s.agent_input_ack ?? 0) + consumed,
              })
              .eq("id", sid);
          }
        }

        // 3. Append outputs
        if (data.outputs) {
          for (const o of data.outputs) {
            const { data: s } = await supabaseAdmin
              .from("terminal_sessions")
              .select("id, output_buffer, output_seq, server_id, status")
              .eq("id", o.session_id)
              .single();
            if (!s || s.server_id !== srv.id) continue;
            if (s.status === "closed") continue;
            let buf = (s.output_buffer || "") + o.b64;
            let extraAck = 0;
            if (buf.length > MAX_OUTPUT_BUFFER) {
              extraAck = buf.length - MAX_OUTPUT_BUFFER;
              buf = buf.slice(extraAck);
            }
            await supabaseAdmin
              .from("terminal_sessions")
              .update({
                output_buffer: buf,
                output_seq: (s.output_seq ?? 0) + o.b64.length,
              })
              .eq("id", o.session_id);
          }
        }

        // 4. Mark agent poll + promote requested → active
        await supabaseAdmin
          .from("terminal_sessions")
          .update({ last_agent_poll_at: now.toISOString(), status: "active" })
          .eq("server_id", srv.id)
          .eq("status", "requested");

        // 5. Return active sessions for this server
        const { data: sessions } = await supabaseAdmin
          .from("terminal_sessions")
          .select("id, status, cols, rows, input_buffer, closed_at")
          .eq("server_id", srv.id)
          .order("created_at", { ascending: true });

        const out = (sessions ?? []).map((s) => ({
          id: s.id,
          status: s.status,
          cols: s.cols,
          rows: s.rows,
          input_b64: s.input_buffer || "",
        })).filter((s) => s.status !== "closed" || (s.input_b64 && s.input_b64.length > 0));

        // Mark agent poll on all returned sessions
        if (out.length > 0) {
          await supabaseAdmin
            .from("terminal_sessions")
            .update({ last_agent_poll_at: now.toISOString() })
            .in("id", out.map((s) => s.id));
        }

        return json({ sessions: out, closed: (sessions ?? []).filter((s) => s.status === "closed").map((s) => s.id) });
        } catch (e) {
          logServerError("agent-terminal", e);
          return errors.server();
        }
      },
    },
  },
});
