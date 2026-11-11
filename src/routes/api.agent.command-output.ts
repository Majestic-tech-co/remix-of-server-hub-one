// POST /api/agent/command-output
// Headers: X-Fleet-Token: <agent_token>
// Body: { command_id, stdout, stderr }
// Streams partial output while a command is running. Does NOT change status.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { authenticateAgent, errors, json, logServerError } from "@/lib/security.server";

const Schema = z.object({
  command_id: z.string().uuid(),
  stdout: z.string().max(200_000).optional().default(""),
  stderr: z.string().max(200_000).optional().default(""),
}).strict();

export const Route = createFileRoute("/api/agent/command-output")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const auth = await authenticateAgent(request, supabaseAdmin, { limit: 300 });
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
            .from("commands").update({ stdout: data.stdout, stderr: data.stderr }).eq("id", data.command_id);
          if (error) { logServerError("command-output", error); return errors.server(); }
          return json({ ok: true });
        } catch (e) {
          logServerError("command-output", e);
          return errors.server();
        }
      },
    },
  },
});
