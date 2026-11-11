// POST /api/servers/create
// Browser auth (Bearer JWT). Creates a server and returns the agent token ONCE.
// Only a SHA-256 hash of the token is stored.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getUserFromRequest } from "@/integrations/supabase/route-auth";
import { audit, errors, generateAgentToken, json, logServerError, rateLimit, sha256Hex } from "@/lib/security.server";

const Schema = z.object({
  name: z.string().trim().min(1).max(100),
  type: z.enum(["local", "aws"]).default("local"),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  region: z.string().trim().max(64).nullable().optional(),
  instance_id: z.string().trim().max(64).nullable().optional(),
  connection_notes: z.string().max(5000).nullable().optional(),
}).strict();

const COLUMNS =
  "id,user_id,name,hostname,ip_address,os,tags,last_seen_at,created_at,type,region,instance_id,connection_notes";

export const Route = createFileRoute("/api/servers/create")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const auth = await getUserFromRequest(request);
          if (auth instanceof Response) return auth;
          const rl = rateLimit(`server-create:${auth.userId}`, 20, 3_600_000);
          if (!rl.ok) return errors.tooMany(rl.retryAfter);

          let body: unknown;
          try { body = await request.json(); } catch { return errors.badRequest(); }
          const parsed = Schema.safeParse(body);
          if (!parsed.success) return errors.badRequest();
          const d = parsed.data;

          // Cap servers per account (service-role inserts bypass the database row-limit triggers).
          const { count } = await supabaseAdmin
            .from("servers")
            .select("id", { count: "exact", head: true })
            .eq("user_id", auth.userId);
          if ((count ?? 0) >= 200) return json({ error: "Server limit reached." }, 403);

          const token = generateAgentToken();
          const { data, error } = await supabaseAdmin
            .from("servers")
            .insert({
              user_id: auth.userId,
              name: d.name,
              type: d.type,
              tags: d.tags,
              region: d.type === "aws" ? d.region || null : null,
              instance_id: d.type === "aws" ? d.instance_id || null : null,
              connection_notes: d.connection_notes?.trim() || null,
              agent_token_hash: await sha256Hex(token),
            })
            .select(COLUMNS)
            .single();
          if (error || !data) {
            if (error) logServerError("server-create", error);
            return errors.server();
          }
          await audit(supabaseAdmin, auth.userId, "server.created", { type: "server", id: data.id }, { name: data.name });
          return json({ server: data, agent_token: token });
        } catch (e) {
          logServerError("server-create", e);
          return errors.server();
        }
      },
    },
  },
});
