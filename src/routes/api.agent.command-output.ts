// POST /api/agent/command-output
// Headers: X-Fleet-Token: <agent_token>
// Body: { command_id, stdout, stderr }
// Used by the agent to stream partial output while a command is still running.
// Does NOT change command status — only updates the stdout/stderr buffers so
// the UI can show live progress (e.g. apt-get update, long installs).
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { z } from "zod";

const Schema = z.object({
  command_id: z.string().uuid(),
  stdout: z.string().max(200_000).optional().default(""),
  stderr: z.string().max(200_000).optional().default(""),
});

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Fleet-Token",
};

export const Route = createFileRoute("/api/agent/command-output")({
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

        const { data: srv } = await supabaseAdmin
          .from("servers")
          .select("id")
          .eq("agent_token", token)
          .single();
        if (!srv) return Response.json({ error: "invalid token" }, { status: 401, headers: corsHeaders });

        const { data: cmd } = await supabaseAdmin
          .from("commands")
          .select("id, server_id, status")
          .eq("id", data.command_id)
          .single();
        if (!cmd || cmd.server_id !== srv.id) {
          return Response.json({ error: "command not found" }, { status: 404, headers: corsHeaders });
        }
        // Don't overwrite final results once command-result has landed.
        if (cmd.status === "completed" || cmd.status === "failed") {
          return Response.json({ ok: true, ignored: true }, { headers: corsHeaders });
        }

        await supabaseAdmin
          .from("commands")
          .update({ stdout: data.stdout, stderr: data.stderr })
          .eq("id", data.command_id);

        return Response.json({ ok: true }, { headers: corsHeaders });
      },
    },
  },
});
