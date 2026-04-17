// POST /api/agent/command-result
// Headers: X-Fleet-Token: <agent_token>
// Body: { command_id, exit_code, stdout, stderr }
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { z } from "zod";

const Schema = z.object({
  command_id: z.string().uuid(),
  exit_code: z.number().int(),
  stdout: z.string().max(200_000).optional().default(""),
  stderr: z.string().max(200_000).optional().default(""),
});

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Fleet-Token",
};

export const Route = createFileRoute("/api/agent/command-result")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: corsHeaders }),
      POST: async ({ request }) => {
        const token = request.headers.get("x-fleet-token");
        if (!token) return Response.json({ error: "missing token" }, { status: 401, headers: corsHeaders });

        let body: unknown;
        try { body = await request.json(); } catch { return Response.json({ error: "invalid json" }, { status: 400, headers: corsHeaders }); }
        const parsed = Schema.safeParse(body);
        if (!parsed.success) return Response.json({ error: "invalid payload" }, { status: 400, headers: corsHeaders });
        const data = parsed.data;

        // Verify the command belongs to a server owned by the token
        const { data: srv } = await supabaseAdmin
          .from("servers")
          .select("id")
          .eq("agent_token", token)
          .single();
        if (!srv) return Response.json({ error: "invalid token" }, { status: 401, headers: corsHeaders });

        const { data: cmd } = await supabaseAdmin
          .from("commands")
          .select("id, server_id")
          .eq("id", data.command_id)
          .single();
        if (!cmd || cmd.server_id !== srv.id) {
          return Response.json({ error: "command not found" }, { status: 404, headers: corsHeaders });
        }

        await supabaseAdmin
          .from("commands")
          .update({
            status: data.exit_code === 0 ? "completed" : "failed",
            exit_code: data.exit_code,
            stdout: data.stdout,
            stderr: data.stderr,
            completed_at: new Date().toISOString(),
          })
          .eq("id", data.command_id);

        return Response.json({ ok: true }, { headers: corsHeaders });
      },
    },
  },
});
