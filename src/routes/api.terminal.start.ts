// POST /api/terminal/start
// Browser auth (Bearer token). Body: { server_id, cols, rows }
// Creates a new terminal session and returns its id.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getUserFromRequest } from "@/integrations/supabase/route-auth";

const Schema = z.object({
  server_id: z.string().uuid(),
  cols: z.number().int().min(20).max(500).default(80),
  rows: z.number().int().min(5).max(200).default(24),
});

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export const Route = createFileRoute("/api/terminal/start")({
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

        // Verify server ownership
        const { data: srv } = await supabaseAdmin
          .from("servers")
          .select("id, user_id")
          .eq("id", parsed.data.server_id)
          .single();
        if (!srv || srv.user_id !== auth.userId) {
          return Response.json({ error: "not found" }, { status: 404, headers: corsHeaders });
        }

        // Close any other open sessions for this user+server (one active shell at a time)
        await supabaseAdmin
          .from("terminal_sessions")
          .update({ status: "closed", closed_at: new Date().toISOString() })
          .eq("server_id", srv.id)
          .eq("user_id", auth.userId)
          .in("status", ["requested", "active"]);

        const { data: created, error } = await supabaseAdmin
          .from("terminal_sessions")
          .insert({
            server_id: srv.id,
            user_id: auth.userId,
            cols: parsed.data.cols,
            rows: parsed.data.rows,
            status: "requested",
          })
          .select("id")
          .single();
        if (error || !created) {
          return Response.json({ error: "failed to create" }, { status: 500, headers: corsHeaders });
        }

        return Response.json({ session_id: created.id }, { headers: corsHeaders });
      },
    },
  },
});
