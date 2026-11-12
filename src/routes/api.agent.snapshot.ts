// POST /api/agent/snapshot
// Headers: X-Fleet-Token: <agent_token>
// Body: { services: [...], containers: [...], processes: [...] }  (names and numbers only)
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { authenticateAgent, errors, json, logServerError } from "@/lib/security.server";

const short = (n: number) => z.string().max(n);
const SnapshotSchema = z.object({
  services: z.array(z.object({
    name: short(128), active: short(32), sub: short(32), description: short(200).optional().default(""),
  }).strict()).max(300).default([]),
  containers: z.array(z.object({
    name: short(128), image: short(200), state: short(32), status: short(100),
  }).strict()).max(100).default([]),
  processes: z.array(z.object({
    pid: z.number().int().min(0).max(4_194_304), user: short(64), cpu: z.number().min(0).max(100_000),
    mem: z.number().min(0).max(100_000), name: short(64),
  }).strict()).max(25).default([]),
  docker: z.boolean().optional().default(false),
  collected_at: short(40).optional(),
}).strict();

export const Route = createFileRoute("/api/agent/snapshot")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const auth = await authenticateAgent(request, supabaseAdmin, { limit: 20 });
          if (auth instanceof Response) return auth;

          const text = await request.text();
          if (text.length > 150_000) return errors.badRequest();
          let body: unknown;
          try { body = JSON.parse(text); } catch { return errors.badRequest(); }
          const parsed = SnapshotSchema.safeParse(body);
          if (!parsed.success) return errors.badRequest();

          const { error } = await supabaseAdmin.from("server_snapshots")
            // workspace_id is a placeholder: a database trigger always overwrites it from the server's real team
            .upsert({ server_id: auth.serverId, data: parsed.data, workspace_id: auth.serverId }, { onConflict: "server_id" });
          if (error) { logServerError("snapshot", error); return errors.server(); }
          return json({ ok: true });
        } catch (e) {
          logServerError("snapshot", e);
          return errors.server();
        }
      },
    },
  },
});
