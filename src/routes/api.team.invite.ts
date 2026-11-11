// POST /api/team/invite
// Browser auth. Admins and owners invite people by email (admins may invite members and viewers,
// only owners may invite admins) or revoke a pending invitation.
// The invited person joins automatically after signing in with that (confirmed) email.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getUserFromRequest } from "@/integrations/supabase/route-auth";
import { audit, errors, getRole, json, logServerError, rateLimit, roleAtLeast } from "@/lib/security.server";

const Schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    workspace_id: z.string().uuid(),
    email: z.string().trim().toLowerCase().email().max(254),
    role: z.enum(["admin", "member", "viewer"]),
  }).strict(),
  z.object({ action: z.literal("revoke"), invite_id: z.string().uuid() }).strict(),
]);

const MAX_PENDING = 50;

export const Route = createFileRoute("/api/team/invite")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const auth = await getUserFromRequest(request);
          if (auth instanceof Response) return auth;
          const rl = rateLimit(`team-invite:${auth.userId}`, 30, 3_600_000);
          if (!rl.ok) return errors.tooMany(rl.retryAfter);

          let body: unknown;
          try { body = await request.json(); } catch { return errors.badRequest(); }
          const parsed = Schema.safeParse(body);
          if (!parsed.success) return errors.badRequest();
          const d = parsed.data;

          if (d.action === "revoke") {
            const { data: inv } = await supabaseAdmin
              .from("workspace_invites").select("id, workspace_id, email").eq("id", d.invite_id).is("accepted_at", null).maybeSingle();
            if (!inv) return errors.notFound();
            const role = await getRole(supabaseAdmin, auth.userId, inv.workspace_id);
            if (!role) return errors.notFound();
            if (!roleAtLeast(role, "admin")) return json({ error: "You don't have permission to do that." }, 403);
            const { error } = await supabaseAdmin.from("workspace_invites").delete().eq("id", inv.id);
            if (error) { logServerError("team-invite", error); return errors.server(); }
            await audit(supabaseAdmin, auth.userId, "team.invite_revoked", { type: "workspace", id: inv.workspace_id }, { email: inv.email }, inv.workspace_id);
            return json({ ok: true });
          }

          const role = await getRole(supabaseAdmin, auth.userId, d.workspace_id);
          if (!role) return errors.notFound();
          if (!roleAtLeast(role, "admin")) return json({ error: "You don't have permission to do that." }, 403);
          if (d.role === "admin" && role !== "owner") return json({ error: "Only an owner can invite an admin." }, 403);

          const { count } = await supabaseAdmin
            .from("workspace_invites").select("id", { count: "exact", head: true })
            .eq("workspace_id", d.workspace_id).is("accepted_at", null);
          if ((count ?? 0) >= MAX_PENDING) return json({ error: "Too many pending invitations. Revoke some first." }, 403);

          const { error } = await supabaseAdmin.from("workspace_invites").insert({
            workspace_id: d.workspace_id, email: d.email, role: d.role, invited_by: auth.userId,
          });
          if (error) {
            if ((error as { code?: string }).code === "23505") return json({ ok: true, already_invited: true });
            logServerError("team-invite", error);
            return errors.server();
          }

          // Send Supabase's invitation email (creates the account if it doesn't exist yet).
          // If the person already has an account this fails harmlessly: they simply join the next
          // time they sign in. Nothing here depends on the email being delivered.
          let emailed = false;
          try {
            const { error: mailErr } = await supabaseAdmin.auth.admin.inviteUserByEmail(d.email, {
              redirectTo: new URL(request.url).origin + "/reset-password",
            });
            emailed = !mailErr;
          } catch (e) {
            logServerError("team-invite-email", e);
          }

          await audit(supabaseAdmin, auth.userId, "team.invited", { type: "workspace", id: d.workspace_id }, { email: d.email, role: d.role }, d.workspace_id);
          return json({ ok: true, emailed });
        } catch (e) {
          logServerError("team-invite", e);
          return errors.server();
        }
      },
    },
  },
});
