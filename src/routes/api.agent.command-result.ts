// POST /api/agent/command-result
// Headers: X-Fleet-Token: <agent_token>
// Body: { command_id, exit_code, stdout, stderr }
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { authenticateAgent, errors, json, logServerError } from "@/lib/security.server";

const Schema = z.object({
  command_id: z.string().uuid(),
  exit_code: z.number().int(),
  stdout: z.string().max(200_000).optional().default(""),
  stderr: z.string().max(200_000).optional().default(""),
}).strict();

export const Route = createFileRoute("/api/agent/command-result")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const auth = await authenticateAgent(request, supabaseAdmin, { limit: 120 });
          if (auth instanceof Response) return auth;

          let body: unknown;
          try { body = await request.json(); } catch { return errors.badRequest(); }
          const parsed = Schema.safeParse(body);
          if (!parsed.success) return errors.badRequest();
          const data = parsed.data;

          const { data: cmd } = await supabaseAdmin
            .from("commands").select("id, server_id, status").eq("id", data.command_id).maybeSingle();
          if (!cmd || cmd.server_id !== auth.serverId) return errors.notFound();
          if (cmd.status === "completed" || cmd.status === "failed") return json({ ok: true, ignored: true });

          const { error } = await supabaseAdmin
            .from("commands")
            .update({
              status: data.exit_code === 0 ? "completed" : "failed",
              exit_code: data.exit_code,
              stdout: data.stdout,
              stderr: data.stderr,
              completed_at: new Date().toISOString(),
            })
            .eq("id", data.command_id)
            .in("status", ["pending", "running"]);
          if (error) { logServerError("command-result", error); return errors.server(); }
          return json({ ok: true });
        } catch (e) {
          logServerError("command-result", e);
          return errors.server();
        }
      },
    },
  },
});
