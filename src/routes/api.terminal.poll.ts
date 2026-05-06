// POST /api/terminal/poll
// Browser auth. Body: { session_id, output_ack, input_b64?, cols?, rows?, close? }
// Single endpoint that:
//   1. (optional) appends typed bytes to input_buffer
//   2. (optional) updates terminal size
//   3. (optional) closes the session
//   4. advances client_output_ack and returns any new output bytes since
//      the previous ack (server-side truncation keeps DB row small)
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getUserFromRequest } from "@/integrations/supabase/route-auth";

const Schema = z.object({
  session_id: z.string().uuid(),
  output_ack: z.number().int().min(0).default(0),
  input_b64: z.string().max(64_000).optional(),
  cols: z.number().int().min(20).max(500).optional(),
  rows: z.number().int().min(5).max(200).optional(),
  close: z.boolean().optional(),
});

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const MAX_INPUT_BUFFER = 256_000; // 256KB cap

export const Route = createFileRoute("/api/terminal/poll")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: corsHeaders }),
      POST: async ({ request }) => {
        const auth = await getUserFromRequest(request);
        if (auth instanceof Response) return auth;

        let body: unknown;
        try { body = await request.json(); } catch { return Response.json({ error: "invalid json" }, { status: 400, headers: corsHeaders }); }
        const parsed = Schema.safeParse(body);
        if (!parsed.success) return Response.json({ error: "invalid payload" }, { status: 400, headers: corsHeaders });
        const data = parsed.data;

        const { data: sess, error: sessErr } = await supabaseAdmin
          .from("terminal_sessions")
          .select("*")
          .eq("id", data.session_id)
          .single();
        if (sessErr || !sess || sess.user_id !== auth.userId) {
          return Response.json({ error: "not found" }, { status: 404, headers: corsHeaders });
        }

        // Build update payload
        const now = new Date().toISOString();
        const update: Record<string, unknown> = { last_client_poll_at: now };

        if (data.close) {
          update.status = "closed";
          update.closed_at = now;
        }
        if (data.cols && data.cols !== sess.cols) update.cols = data.cols;
        if (data.rows && data.rows !== sess.rows) update.rows = data.rows;

        // Append input bytes
        if (data.input_b64 && data.input_b64.length > 0 && sess.status !== "closed") {
          let next = (sess.input_buffer || "") + data.input_b64;
          if (next.length > MAX_INPUT_BUFFER) {
            // overflow: drop oldest (input is base64 chunks separated by '\n' — we keep tail).
            next = next.slice(next.length - MAX_INPUT_BUFFER);
          }
          update.input_buffer = next;
          update.input_seq = (sess.input_seq ?? 0) + 1;
        }

        // Advance output ack and compute slice to return
        const outputBuffer = sess.output_buffer || "";
        const outputSeq = sess.output_seq ?? 0;
        // output_buffer holds bytes whose position is [client_output_ack, output_seq).
        // Each char = 1 base64 chunk separator? Simpler model: output_seq counts
        // total bytes ever appended; output_buffer contains bytes >= client_output_ack.
        const startInBuffer = Math.max(0, data.output_ack - (sess.client_output_ack ?? 0));
        const newSlice = startInBuffer < outputBuffer.length ? outputBuffer.slice(startInBuffer) : "";
        const newAck = (sess.client_output_ack ?? 0) + startInBuffer;
        // Truncate buffer up to ack (free DB space)
        if (startInBuffer > 0) {
          update.output_buffer = outputBuffer.slice(startInBuffer);
          update.client_output_ack = newAck;
        } else if (data.output_ack > (sess.client_output_ack ?? 0)) {
          update.client_output_ack = data.output_ack;
        }

        await supabaseAdmin
          .from("terminal_sessions")
          .update(update)
          .eq("id", sess.id);

        return Response.json(
          {
            status: data.close ? "closed" : sess.status,
            output_b64: newSlice,
            output_seq: outputSeq,
            cols: sess.cols,
            rows: sess.rows,
          },
          { headers: corsHeaders },
        );
      },
    },
  },
});
