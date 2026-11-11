// POST /api/team/workspace
// Browser auth. Create a workspace, or (owners only) rename / delete one.
// Deleting removes every server, command, playbook, alert and log in it.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getUserFromRequest } from "@/integrations/supabase/route-auth";
import { audit, errors, getRole, json, logServerError, rateLimit } from "@/lib/security.server";

const Name = z.string().trim().min(1).max(100);
const Schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), name: Name }).strict(),
  z.object({ action: z.literal("rename"), workspace_id: z.string().uuid(), name: Name }).strict(),
  z.object({ action: z.literal("delete"), workspace_id: z.string().uuid(), confirm_name: z.string().max(100) }).strict(),
]);

const MAX_OWNED = 10;

export const Route = createFileRoute("/api/team/workspace")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const auth = await getUserFromRequest(request);
          if (auth instanceof Response) return auth;
          const rl = rateLimit(`team-workspace:${auth.userId}`, 20, 3_600_000);
          if (!rl.ok) return errors.tooMany(rl.retryAfter);

          let body: unknown;
          try { body = await request.json(); } catch { return errors.badRequest(); }
          const parsed = Schema.safeParse(body);
          if (!parsed.success) return errors.badRequest();
          const d = parsed.data;

          if (d.action === "create") {
            const { count } = await supabaseAdmin
              .from("workspace_members").select("workspace_id", { count: "exact", head: true })
              .eq("user_id", auth.userId).eq("role", "owner");
            if ((count ?? 0) >= MAX_OWNED) return json({ error: "Workspace limit reached." }, 403);
            const { data: ws, error } = await supabaseAdmin
              .from("workspaces").insert({ name: d.name, created_by: auth.userId }).select("id, name").single();
            if (error || !ws) { if (error) logServerError("team-workspace", error); return errors.server(); }
            const { error: mErr } = await supabaseAdmin
              .from("workspace_members").insert({ workspace_id: ws.id, user_id: auth.userId, role: "owner" });
            if (mErr) {
              logServerError("team-workspace", mErr);
              await supabaseAdmin.from("workspaces").delete().eq("id", ws.id); // don't leave an ownerless workspace
              return errors.server();
            }
            await audit(supabaseAdmin, auth.userId, "workspace.created", { type: "workspace", id: ws.id }, { name: ws.name }, ws.id);
            return json({ workspace: { id: ws.id, name: ws.name, role: "owner" } });
          }

          const role = await getRole(supabaseAdmin, auth.userId, d.workspace_id);
          if (!role) return errors.notFound();
          if (role !== "owner") return json({ error: "Only an owner can do that." }, 403);

          if (d.action === "rename") {
            const { error } = await supabaseAdmin.from("workspaces").update({ name: d.name }).eq("id", d.workspace_id);
            if (error) { logServerError("team-workspace", error); return errors.server(); }
            await audit(supabaseAdmin, auth.userId, "workspace.renamed", { type: "workspace", id: d.workspace_id }, { name: d.name }, d.workspace_id);
            return json({ ok: true });
          }

          // delete: must type the exact name
          const { data: ws } = await supabaseAdmin.from("workspaces").select("name").eq("id", d.workspace_id).maybeSingle();
          if (!ws) return errors.notFound();
          if (d.confirm_name.trim() !== ws.name) return json({ error: "The name you typed doesn't match." }, 400);
          const { error } = await supabaseAdmin.from("workspaces").delete().eq("id", d.workspace_id);
          if (error) { logServerError("team-workspace", error); return errors.server(); }
          await audit(supabaseAdmin, auth.userId, "workspace.deleted", { type: "workspace" }, { name: ws.name });
          return json({ ok: true });
        } catch (e) {
          logServerError("team-workspace", e);
          return errors.server();
        }
      },
    },
  },
});
