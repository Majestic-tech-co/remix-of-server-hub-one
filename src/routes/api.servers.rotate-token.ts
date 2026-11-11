// POST /api/servers/rotate-token
// Browser auth (Bearer JWT). Admins and owners issue a new agent token for a server in their
// workspace. The old token stops working immediately; the new one is returned ONCE.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getUserFromRequest } from "@/integrations/supabase/route-auth";
import {
  audit, errors, generateAgentToken, getServerAccess, json, logServerError, rateLimit, roleAtLeast, sha256Hex,
} from "@/lib/security.server";

const Schema = z.object({ server_id: z.string().uuid() }).strict();

export const Route = createFileRoute("/api/servers/rotate-token")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const auth = await getUserFromRequest(request);
          if (auth instanceof Response) return auth;
          const rl = rateLimit(`server-rotate:${auth.userId}`, 10, 60_000);
          if (!rl.ok) return errors.tooMany(rl.retryAfter);

          let body: unknown;
          try { body = await request.json(); } catch { return errors.badRequest(); }
          const parsed = Schema.safeParse(body);
          if (!parsed.success) return errors.badRequest();

          const access = await getServerAccess(supabaseAdmin, auth.userId, parsed.data.server_id);
          if (!access || !access.role) return errors.notFound(); // don't reveal servers in other workspaces
          if (!roleAtLeast(access.role, "admin")) return json({ error: "Only admins can rotate agent tokens." }, 403);

          const token = generateAgentToken();
          const { data, error } = await supabaseAdmin
            .from("servers")
            .update({ agent_token_hash: await sha256Hex(token) })
            .eq("id", parsed.data.server_id)
            .select("id")
            .maybeSingle();
          if (error) {
            logServerError("server-rotate", error);
            return errors.server();
          }
          if (!data) return errors.notFound();
          await audit(supabaseAdmin, auth.userId, "server.token_rotated", { type: "server", id: data.id }, {}, access.workspaceId);
          return json({ agent_token: token });
        } catch (e) {
          logServerError("server-rotate", e);
          return errors.server();
        }
      },
    },
  },
});
