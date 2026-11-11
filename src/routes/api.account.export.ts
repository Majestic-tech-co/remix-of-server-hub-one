// POST /api/account/export
// Browser auth (Bearer JWT). Returns everything we hold about the caller as a JSON download.
// Secrets are never included (agent token hashes, terminal buffers).
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getUserFromRequest } from "@/integrations/supabase/route-auth";
import { errors, logServerError, rateLimit } from "@/lib/security.server";

const SERVER_COLS =
  "id,name,hostname,ip_address,os,tags,type,region,instance_id,connection_notes,last_seen_at,created_at";
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
          const [user, servers, commands, tasks, runs, logs, sessions] = await Promise.all([
            supabaseAdmin.auth.admin.getUserById(uid),
            supabaseAdmin.from("servers").select(SERVER_COLS).eq("user_id", uid),
            supabaseAdmin.from("commands").select("id,server_id,command,status,exit_code,stdout,stderr,created_at,started_at,completed_at").eq("user_id", uid).order("created_at", { ascending: false }).limit(20_000),
            supabaseAdmin.from("automation_tasks").select("id,name,description,script_content,created_at,updated_at").eq("user_id", uid),
            supabaseAdmin.from("automation_runs").select("id,task_id,status,started_at,finished_at").eq("user_id", uid),
            supabaseAdmin.from("task_logs").select("id,run_id,server_id,command_id,status,output_log,created_at").eq("user_id", uid),
            supabaseAdmin.from("terminal_sessions").select("id,server_id,status,created_at,closed_at").eq("user_id", uid),
          ]);

          const failed = [servers, commands, tasks, runs, logs, sessions].find((r) => r.error);
          if (failed?.error) {
            logServerError("account-export", failed.error);
            return errors.server();
          }

          const serverIds = (servers.data ?? []).map((s) => s.id);
          let metrics: unknown[] = [];
          if (serverIds.length > 0) {
            const m = await supabaseAdmin
              .from("metrics")
              .select("*")
              .in("server_id", serverIds)
              .order("recorded_at", { ascending: false })
              .limit(METRICS_CAP);
            if (m.error) {
              logServerError("account-export", m.error);
              return errors.server();
            }
            metrics = m.data ?? [];
          }

          const payload = {
            exported_at: new Date().toISOString(),
            account: { id: uid, email: user.data.user?.email ?? null, created_at: user.data.user?.created_at ?? null },
            servers: servers.data,
            commands: commands.data,
            automation_tasks: tasks.data,
            automation_runs: runs.data,
            task_logs: logs.data,
            terminal_sessions: sessions.data,
            metrics,
            notes: `Metrics are limited to the most recent ${METRICS_CAP} samples. Agent tokens and terminal contents are not included.`,
          };

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
