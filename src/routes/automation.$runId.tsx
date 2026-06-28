import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { RequireAuth } from "@/components/RequireAuth";
import { AppShell } from "@/components/AppShell";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { ArrowLeft, CheckCircle2, XCircle, Loader2, Clock } from "lucide-react";

export const Route = createFileRoute("/automation/$runId")({
  component: () => (
    <RequireAuth>
      <AppShell>
        <RunView />
      </AppShell>
    </RequireAuth>
  ),
});

interface Log {
  id: string; server_id: string; command_id: string | null; status: string; output_log: string | null;
}
interface Command {
  id: string; status: string; exit_code: number | null; stdout: string | null; stderr: string | null;
}
interface Server { id: string; name: string; }

function RunView() {
  const { runId } = Route.useParams();
  const { user } = useAuth();
  const [logs, setLogs] = useState<Log[]>([]);
  const [commands, setCommands] = useState<Record<string, Command>>({});
  const [servers, setServers] = useState<Record<string, Server>>({});
  const [run, setRun] = useState<{ status: string; started_at: string; task_id: string } | null>(null);
  const [taskName, setTaskName] = useState("");

  useEffect(() => {
    if (!user) return;
    const load = async () => {
      const { data: r } = await supabase.from("automation_runs").select("*").eq("id", runId).single();
      if (r) {
        setRun(r as any);
        const { data: t } = await supabase.from("automation_tasks").select("name").eq("id", r.task_id).single();
        if (t) setTaskName((t as any).name);
      }
      const { data: l } = await supabase.from("task_logs").select("*").eq("run_id", runId);
      const ls = (l ?? []) as Log[];
      setLogs(ls);

      const cmdIds = ls.map((x) => x.command_id).filter(Boolean) as string[];
      const srvIds = ls.map((x) => x.server_id);
      if (cmdIds.length) {
        const { data: cs } = await supabase.from("commands")
          .select("id,status,exit_code,stdout,stderr").in("id", cmdIds);
        const map: Record<string, Command> = {};
        for (const c of (cs ?? []) as Command[]) map[c.id] = c;
        setCommands(map);
      }
      if (srvIds.length) {
        const { data: ss } = await supabase.from("servers").select("id,name").in("id", srvIds);
        const map: Record<string, Server> = {};
        for (const s of (ss ?? []) as Server[]) map[s.id] = s;
        setServers(map);
      }

      // roll up run status
      if (r && r.status === "running" && ls.length) {
        const allDone = ls.every((x) => {
          const c = x.command_id ? commands[x.command_id] : null;
          return c && (c.status === "completed" || c.status === "failed");
        });
        if (allDone) {
          const anyFailed = ls.some((x) => {
            const c = x.command_id ? commands[x.command_id] : null;
            return c?.status === "failed" || (c?.exit_code ?? 0) !== 0;
          });
          await supabase.from("automation_runs").update({
            status: anyFailed ? "failed" : "success",
            finished_at: new Date().toISOString(),
          }).eq("id", runId);
        }
      }
    };
    load();
    const i = setInterval(load, 2000);
    return () => clearInterval(i);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, runId]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Link to="/automation" className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-3 w-3" /> back
          </Link>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight">{taskName || "Run"}</h2>
          {run && (
            <div className="mt-1 font-mono text-xs text-muted-foreground">
              {new Date(run.started_at).toLocaleString()} · {run.status}
            </div>
          )}
        </div>
      </div>

      <div className="grid gap-3">
        {logs.length === 0 && <div className="text-sm text-muted-foreground">No targets.</div>}
        {logs.map((l) => {
          const cmd = l.command_id ? commands[l.command_id] : undefined;
          const srv = servers[l.server_id];
          const status = cmd?.status ?? "pending";
          const output = [cmd?.stdout, cmd?.stderr].filter(Boolean).join("\n") || "Waiting for agent…";
          return (
            <Card key={l.id} className="overflow-hidden">
              <div className="flex items-center justify-between border-b border-border/60 px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <StatusIcon status={status} />
                  <Link to="/servers/$id" params={{ id: l.server_id }} className="font-medium hover:underline">
                    {srv?.name ?? l.server_id}
                  </Link>
                </div>
                <div className="flex items-center gap-3 font-mono text-[10px] uppercase text-muted-foreground">
                  {cmd?.exit_code != null && <span>exit {cmd.exit_code}</span>}
                  <span>{status}</span>
                </div>
              </div>
              <pre className="max-h-72 overflow-auto bg-terminal p-4 font-mono text-xs text-terminal-foreground">
                {output}
              </pre>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function StatusIcon({ status }: { status: string }) {
  if (status === "running") return <Loader2 className="h-4 w-4 animate-spin text-primary" />;
  if (status === "completed") return <CheckCircle2 className="h-4 w-4 text-primary" />;
  if (status === "failed") return <XCircle className="h-4 w-4 text-destructive" />;
  return <Clock className="h-4 w-4 text-muted-foreground" />;
}
