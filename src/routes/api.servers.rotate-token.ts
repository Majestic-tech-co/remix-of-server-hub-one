// POST /api/servers/rotate-token
// Browser auth (Bearer JWT). Issues a new agent token for a server the caller owns.
// The old token stops working immediately; the new one is returned ONCE.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getUserFromRequest } from "@/integrations/supabase/route-auth";
import { errors, generateAgentToken, json, logServerError, rateLimit, sha256Hex } from "@/lib/security.server";

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

          const token = generateAgentToken();
          const { data, error } = await supabaseAdmin
            .from("servers")
            .update({ agent_token_hash: await sha256Hex(token) })
            .eq("id", parsed.data.server_id)
            .eq("user_id", auth.userId)
            .select("id")
            .maybeSingle();
          if (error) {
            logServerError("server-rotate", error);
            return errors.server();
          }
          if (!data) return errors.notFound();
          return json({ agent_token: token });
        } catch (e) {
          logServerError("server-rotate", e);
          return errors.server();
        }
      },
    },
  },
});
