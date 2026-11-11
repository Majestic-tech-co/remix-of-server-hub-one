// POST /api/account/export
// Browser auth (Bearer JWT). Returns the caller's data as a JSON download:
//   - their account, memberships and the activity they caused (commands they ran, audit events,
//     terminal sessions), and
//   - the full contents of workspaces they OWN (servers, playbooks, runs, logs, metrics).
// Data in teams they merely belong to is the team's, and is not included.
// Secrets are never included (agent token hashes, terminal buffers).
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getUserFromRequest } from "@/integrations/supabase/route-auth";
import { audit, errors, logServerError, rateLimit } from "@/lib/security.server";

const SERVER_COLS =
  "id,workspace_id,name,hostname,ip_address,os,tags,type,region,instance_id,connection_notes,last_seen_at,created_at";
const METRICS_CAP = 100_000;

export const Route = createFileRoute("/api/account/export")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const auth = await getUserFromRequest(request);
          if (auth instanceof Response) return auth;
          const rl = rateLimit(`account-export:${auth.userId}`, 5, 3_600_000);
          if (!rl.ok) return errors.tooMany(rl.retryAfter);
          const uid = auth.userId;

          const [user, members] = await Promise.all([
            supabaseAdmin.auth.admin.getUserById(uid),
            supabaseAdmin.from("workspace_members").select("workspace_id,role,created_at").eq("user_id", uid),
          ]);
          if (members.error) { logServerError("account-export", members.error); return errors.server(); }
          const memberships = members.data ?? [];
          const ownedIds = memberships.filter((m) => m.role === "owner").map((m) => m.workspace_id);
          const none = ["00000000-0000-0000-0000-000000000000"]; // `.in()` needs a non-empty list
          const owned = ownedIds.length ? ownedIds : none;

          const [workspaces, servers, tasks, runs, commands, audits, sessions] = await Promise.all([
            supabaseAdmin.from("workspaces").select("id,name,created_at").in("id", memberships.length ? memberships.map((m) => m.workspace_id) : none),
            supabaseAdmin.from("servers").select(SERVER_COLS).in("workspace_id", owned),
            supabaseAdmin.from("automation_tasks").select("id,workspace_id,name,description,script_content,created_at,updated_at").in("workspace_id", owned),
            supabaseAdmin.from("automation_runs").select("id,workspace_id,task_id,status,started_at,finished_at").or(`user_id.eq.${uid},workspace_id.in.(${owned.join(",")})`),
            supabaseAdmin.from("commands").select("id,server_id,command,status,exit_code,stdout,stderr,created_at,started_at,completed_at").eq("user_id", uid).order("created_at", { ascending: false }).limit(20_000),
            supabaseAdmin.from("audit_log").select("id,workspace_id,action,target_type,target_id,detail,created_at").eq("user_id", uid).order("created_at", { ascending: false }).limit(20_000),
            supabaseAdmin.from("terminal_sessions").select("id,server_id,status,created_at,closed_at").eq("user_id", uid),
          ]);
          const failed = [workspaces, servers, tasks, runs, commands, audits, sessions].find((r) => r.error);
          if (failed?.error) { logServerError("account-export", failed.error); return errors.server(); }

          const serverIds = (servers.data ?? []).map((s) => s.id);
          let metrics: unknown[] = [];
          let logs: unknown[] = [];
          if (serverIds.length > 0) {
            const [m, l] = await Promise.all([
              supabaseAdmin.from("metrics").select("*").in("server_id", serverIds).order("recorded_at", { ascending: false }).limit(METRICS_CAP),
              supabaseAdmin.from("task_logs").select("id,run_id,server_id,command_id,status,output_log,created_at").in("server_id", serverIds),
            ]);
            if (m.error || l.error) { logServerError("account-export", m.error ?? l.error); return errors.server(); }
            metrics = m.data ?? [];
            logs = l.data ?? [];
          }

          const payload = {
            exported_at: new Date().toISOString(),
            account: { id: uid, email: user.data.user?.email ?? null, created_at: user.data.user?.created_at ?? null },
            workspaces: workspaces.data,
            memberships,
            servers: servers.data,
            automation_tasks: tasks.data,
            automation_runs: runs.data,
            task_logs: logs,
            metrics,
            commands_you_ran: commands.data,
            audit_events_about_you: audits.data,
            terminal_sessions_you_opened: sessions.data,
            notes: `Servers, playbooks, runs, logs and metrics are included only for workspaces you own (metrics: latest ${METRICS_CAP} samples). Agent tokens and terminal contents are not included.`,
          };

          await audit(supabaseAdmin, uid, "account.exported");
          return new Response(JSON.stringify(payload, null, 2), {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Content-Disposition": 'attachment; filename="fleet-data-export.json"',
              "Cache-Control": "no-store",
            },
          });
        } catch (e) {
          logServerError("account-export", e);
          return errors.server();
        }
      },
    },
  },
});
