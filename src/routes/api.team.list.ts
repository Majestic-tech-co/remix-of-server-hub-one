// POST /api/team/list
// Browser auth. Members of a workspace (with emails) and, for admins, its pending invitations.
// Emails live in the auth system, which the browser cannot read directly, hence this route.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getUserFromRequest } from "@/integrations/supabase/route-auth";
import { errors, getRole, json, logServerError, rateLimit, roleAtLeast } from "@/lib/security.server";

const Schema = z.object({ workspace_id: z.string().uuid() }).strict();

export const Route = createFileRoute("/api/team/list")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const auth = await getUserFromRequest(request);
          if (auth instanceof Response) return auth;
          const rl = rateLimit(`team-list:${auth.userId}`, 120, 60_000);
          if (!rl.ok) return errors.tooMany(rl.retryAfter);

          let body: unknown;
          try { body = await request.json(); } catch { return errors.badRequest(); }
          const parsed = Schema.safeParse(body);
          if (!parsed.success) return errors.badRequest();
          const wsId = parsed.data.workspace_id;

          const role = await getRole(supabaseAdmin, auth.userId, wsId);
          if (!role) return errors.notFound();

          const { data: members, error } = await supabaseAdmin
            .from("workspace_members").select("user_id, role, created_at").eq("workspace_id", wsId).order("created_at", { ascending: true }).limit(200);
          if (error) { logServerError("team-list", error); return errors.server(); }

          const withEmail = await Promise.all(
            (members ?? []).map(async (m) => {
              const { data } = await supabaseAdmin.auth.admin.getUserById(m.user_id);
              return { user_id: m.user_id, role: m.role, created_at: m.created_at, email: data.user?.email ?? "(unknown)", is_you: m.user_id === auth.userId };
            }),
          );

          let invites: unknown[] = [];
          if (roleAtLeast(role, "admin")) {
            const { data } = await supabaseAdmin
              .from("workspace_invites").select("id, email, role, created_at").eq("workspace_id", wsId).is("accepted_at", null).order("created_at", { ascending: false });
            invites = data ?? [];
          }
          return json({ role, members: withEmail, invites });
        } catch (e) {
          logServerError("team-list", e);
          return errors.server();
        }
      },
    },
  },
});
