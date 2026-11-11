// POST /api/team/claim
// Browser auth (Bearer JWT). Called once after sign-in:
//   1. accepts any pending invitations addressed to the caller's CONFIRMED email,
//   2. makes sure the caller belongs to at least one workspace (creates a personal one if not),
//   3. returns the caller's workspaces and roles.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getUserFromRequest } from "@/integrations/supabase/route-auth";
import { audit, errors, json, logServerError, rateLimit } from "@/lib/security.server";

async function loadWorkspaces(uid: string) {
  const { data: members, error } = await supabaseAdmin
    .from("workspace_members")
    .select("workspace_id, role")
    .eq("user_id", uid);
  if (error) throw error;
  const ids = (members ?? []).map((m) => m.workspace_id);
  if (ids.length === 0) return [];
  const { data: ws, error: wErr } = await supabaseAdmin.from("workspaces").select("id, name, require_mfa").in("id", ids);
  if (wErr) throw wErr;
  const info = new Map((ws ?? []).map((w) => [w.id, w]));
  return (members ?? [])
    .map((m) => ({ id: m.workspace_id, name: info.get(m.workspace_id)?.name ?? "Workspace", role: m.role, require_mfa: !!info.get(m.workspace_id)?.require_mfa }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const Route = createFileRoute("/api/team/claim")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const auth = await getUserFromRequest(request);
          if (auth instanceof Response) return auth;
          const rl = rateLimit(`team-claim:${auth.userId}`, 30, 60_000);
          if (!rl.ok) return errors.tooMany(rl.retryAfter);
          const uid = auth.userId;

          const { data: u, error: uErr } = await supabaseAdmin.auth.admin.getUserById(uid);
          if (uErr || !u.user) {
            if (uErr) logServerError("team-claim", uErr);
            return errors.notFound();
          }

          // Only a confirmed email may claim invitations (otherwise anyone could sign up as
          // someone else's address and take their place on a team).
          const email = u.user.email?.trim().toLowerCase();
          if (email && u.user.email_confirmed_at) {
            const { data: invites } = await supabaseAdmin
              .from("workspace_invites")
              .select("id, workspace_id, role")
              .eq("email", email)
              .is("accepted_at", null);
            for (const inv of invites ?? []) {
              // keep an existing (possibly higher) role if they are already a member
              await supabaseAdmin
                .from("workspace_members")
                .upsert({ workspace_id: inv.workspace_id, user_id: uid, role: inv.role }, { onConflict: "workspace_id,user_id", ignoreDuplicates: true });
              await supabaseAdmin.from("workspace_invites").update({ accepted_at: new Date().toISOString() }).eq("id", inv.id);
              await audit(supabaseAdmin, uid, "team.joined", { type: "workspace", id: inv.workspace_id }, { role: inv.role }, inv.workspace_id);
            }
          }

          let workspaces = await loadWorkspaces(uid);
          if (workspaces.length === 0) {
            const { data: ws, error } = await supabaseAdmin
              .from("workspaces")
              .insert({ name: "My workspace", created_by: uid })
              .select("id")
              .single();
            if (error || !ws) {
              if (error) logServerError("team-claim", error);
              return errors.server();
            }
            await supabaseAdmin.from("workspace_members").insert({ workspace_id: ws.id, user_id: uid, role: "owner" });
            workspaces = await loadWorkspaces(uid);
          }
          return json({ workspaces });
        } catch (e) {
          logServerError("team-claim", e);
          return errors.server();
        }
      },
    },
  },
});
