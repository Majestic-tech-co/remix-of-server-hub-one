// POST /api/account/delete
// Browser auth (Bearer JWT). Permanently deletes the caller's account.
//   - The caller must type their own email address as confirmation.
//   - Workspaces where they are the ONLY member are deleted with everything in them.
//   - If they are the only owner of a workspace that other people use, deletion is refused until
//     ownership is handed over (or the workspace is deleted): a team must never be orphaned.
//   - In teams that continue, their history stays but is detached from their identity.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getUserFromRequest } from "@/integrations/supabase/route-auth";
import { errors, json, logServerError, rateLimit } from "@/lib/security.server";

const Schema = z.object({ confirm_email: z.string().trim().min(3).max(254) }).strict();

export const Route = createFileRoute("/api/account/delete")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const auth = await getUserFromRequest(request);
          if (auth instanceof Response) return auth;
          const rl = rateLimit(`account-delete:${auth.userId}`, 3, 3_600_000);
          if (!rl.ok) return errors.tooMany(rl.retryAfter);
          const uid = auth.userId;

          let body: unknown;
          try { body = await request.json(); } catch { return errors.badRequest(); }
          const parsed = Schema.safeParse(body);
          if (!parsed.success) return errors.badRequest();

          const { data: u, error: getErr } = await supabaseAdmin.auth.admin.getUserById(uid);
          if (getErr || !u.user) {
            if (getErr) logServerError("account-delete", getErr);
            return errors.notFound();
          }
          if ((u.user.email ?? "").toLowerCase() !== parsed.data.confirm_email.toLowerCase()) {
            return json({ error: "The email you typed doesn't match this account." }, 400);
          }

          // Work out what happens to each workspace they belong to.
          const { data: mine, error: mErr } = await supabaseAdmin
            .from("workspace_members").select("workspace_id, role").eq("user_id", uid);
          if (mErr) { logServerError("account-delete", mErr); return errors.server(); }

          const toDelete: string[] = [];
          const blocked: string[] = [];
          for (const m of mine ?? []) {
            const { data: all } = await supabaseAdmin
              .from("workspace_members").select("user_id, role").eq("workspace_id", m.workspace_id);
            const others = (all ?? []).filter((x) => x.user_id !== uid);
            if (others.length === 0) toDelete.push(m.workspace_id);
            else if (m.role === "owner" && !others.some((x) => x.role === "owner")) blocked.push(m.workspace_id);
          }
          if (blocked.length > 0) {
            const { data: names } = await supabaseAdmin.from("workspaces").select("name").in("id", blocked);
            const list = (names ?? []).map((n) => `"${n.name}"`).join(", ");
            return json({
              error: `You're the only owner of ${list}, which other people use. Make someone else an owner, or delete the team, before deleting your account.`,
            }, 409);
          }

          if (toDelete.length > 0) {
            const { error } = await supabaseAdmin.from("workspaces").delete().in("id", toDelete);
            if (error) { logServerError("account-delete", error); return errors.server(); }
          }
          // Account-level audit rows go; rows inside teams that continue lose the link to this person.
          await supabaseAdmin.from("audit_log").delete().eq("user_id", uid).is("workspace_id", null);
          await supabaseAdmin.from("audit_log").update({ user_id: null }).eq("user_id", uid);

          const { error } = await supabaseAdmin.auth.admin.deleteUser(uid);
          if (error) {
            logServerError("account-delete", error);
            return errors.server();
          }
          return json({ ok: true });
        } catch (e) {
          logServerError("account-delete", e);
          return errors.server();
        }
      },
    },
  },
});
