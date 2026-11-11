// POST /api/team/member
// Browser auth. Change a member's role, remove a member, or leave a workspace.
//   - admins can manage members and viewers; only owners can touch admins/owners or grant those roles
//   - nobody can change their own role (use "leave"); a workspace can never lose its last owner
//     (enforced by a database trigger as well as here)
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getUserFromRequest } from "@/integrations/supabase/route-auth";
import { audit, errors, getRole, json, logServerError, rateLimit, roleAtLeast } from "@/lib/security.server";

const Schema = z.object({
  action: z.enum(["set_role", "remove", "leave"]),
  workspace_id: z.string().uuid(),
  user_id: z.string().uuid().optional(),
  role: z.enum(["owner", "admin", "member", "viewer"]).optional(),
}).strict();

const LAST_OWNER = "A team needs at least one owner. Make someone else an owner first.";
const FORBIDDEN = () => json({ error: "You don't have permission to do that." }, 403);

export const Route = createFileRoute("/api/team/member")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const auth = await getUserFromRequest(request);
          if (auth instanceof Response) return auth;
          const rl = rateLimit(`team-member:${auth.userId}`, 60, 3_600_000);
          if (!rl.ok) return errors.tooMany(rl.retryAfter);

          let body: unknown;
          try { body = await request.json(); } catch { return errors.badRequest(); }
          const parsed = Schema.safeParse(body);
          if (!parsed.success) return errors.badRequest();
          const d = parsed.data;

          const callerRole = await getRole(supabaseAdmin, auth.userId, d.workspace_id);
          if (!callerRole) return errors.notFound();

          // ---- leave ----
          if (d.action === "leave") {
            const { error } = await supabaseAdmin
              .from("workspace_members").delete().eq("workspace_id", d.workspace_id).eq("user_id", auth.userId);
            if (error) {
              if ((error as { code?: string }).code === "23514") return json({ error: LAST_OWNER }, 409);
              logServerError("team-member", error);
              return errors.server();
            }
            await audit(supabaseAdmin, auth.userId, "team.left", { type: "workspace", id: d.workspace_id }, {}, d.workspace_id);
            return json({ ok: true });
          }

          // ---- set_role / remove ----
          if (!d.user_id || d.user_id === auth.userId) return errors.badRequest();
          if (!roleAtLeast(callerRole, "admin")) return FORBIDDEN();
          const targetRole = await getRole(supabaseAdmin, d.user_id, d.workspace_id);
          if (!targetRole) return errors.notFound();

          if (callerRole !== "owner") {
            // admins: only members/viewers, and only up to member/viewer
            if (roleAtLeast(targetRole, "admin")) return FORBIDDEN();
            if (d.action === "set_role" && (d.role === "owner" || d.role === "admin")) return FORBIDDEN();
          }

          if (d.action === "remove") {
            const { error } = await supabaseAdmin
              .from("workspace_members").delete().eq("workspace_id", d.workspace_id).eq("user_id", d.user_id);
            if (error) {
              if ((error as { code?: string }).code === "23514") return json({ error: LAST_OWNER }, 409);
              logServerError("team-member", error);
              return errors.server();
            }
            await audit(supabaseAdmin, auth.userId, "team.member_removed", { type: "workspace", id: d.workspace_id }, { user_id: d.user_id, role: targetRole }, d.workspace_id);
            return json({ ok: true });
          }

          if (!d.role) return errors.badRequest();
          const { error } = await supabaseAdmin
            .from("workspace_members").update({ role: d.role }).eq("workspace_id", d.workspace_id).eq("user_id", d.user_id);
          if (error) {
            if ((error as { code?: string }).code === "23514") return json({ error: LAST_OWNER }, 409);
            logServerError("team-member", error);
            return errors.server();
          }
          await audit(supabaseAdmin, auth.userId, "team.role_changed", { type: "workspace", id: d.workspace_id }, { user_id: d.user_id, from: targetRole, to: d.role }, d.workspace_id);
          return json({ ok: true });
        } catch (e) {
          logServerError("team-member", e);
          return errors.server();
        }
      },
    },
  },
});
