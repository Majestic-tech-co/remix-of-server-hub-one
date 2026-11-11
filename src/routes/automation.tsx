import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { RequireAuth } from "@/components/RequireAuth";
import { AppShell } from "@/components/AppShell";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Play, Plus, FileCode, Sparkles, Clock, CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { friendlyError } from "@/lib/errors";
import { useWorkspace } from "@/lib/workspace";

export const Route = createFileRoute("/automation")({
  component: () => (
    <RequireAuth>
      <AppShell>
        <Automation />
      </AppShell>
    </RequireAuth>
  ),
});

interface Task {
  id: string; name: string; description: string | null; script_content: string; created_at: string;
}
interface Run {
  id: string; task_id: string; status: string; started_at: string; finished_at: string | null;
}

const DEFAULT_PLAYBOOKS = [
  { name: "Update Packages (apt)", description: "Refresh package index and apply upgrades", script_content: "DEBIAN_FRONTEND=noninteractive apt-get update && DEBIAN_FRONTEND=noninteractive apt-get -y upgrade" },
  { name: "Restart Nginx", description: "Reload nginx configuration safely", script_content: "nginx -t && systemctl reload nginx && systemctl status nginx --no-pager" },
  { name: "Disk Cleanup", description: "Clean apt caches and old journal logs", script_content: "apt-get clean && journalctl --vacuum-time=7d && df -h /" },
  { name: "Show Uptime & Load", description: "Quick health snapshot", script_content: "uptime && free -h && df -h" },
];

function Automation() {
  const { user } = useAuth();
  const { current, can } = useWorkspace();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    if (!current) return;
    const [{ data: t }, { data: r }] = await Promise.all([
      supabase.from("automation_tasks").select("*").eq("workspace_id", current.id).order("created_at", { ascending: false }),
      supabase.from("automation_runs").select("*").eq("workspace_id", current.id).order("started_at", { ascending: false }).limit(20),
    ]);
    setTasks((t ?? []) as Task[]);
    setRuns((r ?? []) as Run[]);
    setLoading(false);
  };

  useEffect(() => { if (user && current) { setLoading(true); load(); } }, [user, current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const seedDefaults = async () => {
    if (!user || !current) return;
    const { error } = await supabase.from("automation_tasks").insert(
      DEFAULT_PLAYBOOKS.map((p) => ({ ...p, user_id: user.id, workspace_id: current.id }))
    );
    if (error) toast.error(friendlyError(error));
    else { toast.success("Loaded 4 default playbooks"); load(); }
  };

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-mono text-xs uppercase tracking-widest text-muted-foreground">// automation</h1>
          <h2 className="mt-1 text-3xl font-semibold tracking-tight">Playbooks</h2>
          <p className="mt-1 text-sm text-muted-foreground">Run scripts across multiple servers in one shot.</p>
        </div>
        <div className="flex gap-2">
          {tasks.length === 0 && !loading && can("admin") && (
            <Button variant="outline" onClick={seedDefaults}>
              <Sparkles className="h-4 w-4" /> Load defaults
            </Button>
          )}
          {can("admin") && <NewPlaybookDialog onCreated={load} />}
        </div>
      </div>

      {loading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : tasks.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 p-12 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <FileCode className="h-5 w-5 text-primary" />
          </div>
          <div className="font-medium">No playbooks yet</div>
          <div className="text-sm text-muted-foreground">Start with our defaults or write your own.</div>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {tasks.map((t) => (
            <TaskCard key={t.id} task={t} onRan={load} />
          ))}
        </div>
      )}

      {runs.length > 0 && (
        <div>
          <h3 className="mb-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">// recent runs</h3>
          <Card className="divide-y divide-border/60">
            {runs.map((r) => {
              const task = tasks.find((t) => t.id === r.task_id);
              return (
                <Link key={r.id} to="/automation/$runId" params={{ runId: r.id }}
                  className="flex items-center justify-between px-4 py-3 hover:bg-muted/40">
                  <div className="flex items-center gap-3">
                    <RunStatusIcon status={r.status} />
                    <div>
                      <div className="font-medium">{task?.name ?? "Unknown playbook"}</div>
                      <div className="font-mono text-xs text-muted-foreground">
                        {new Date(r.started_at).toLocaleString()}
                      </div>
                    </div>
                  </div>
                  <span className="font-mono text-xs uppercase text-muted-foreground">{r.status}</span>
                </Link>
              );
            })}
          </Card>
        </div>
      )}
    </div>
  );
}

function RunStatusIcon({ status }: { status: string }) {
  if (status === "running") return <Loader2 className="h-4 w-4 animate-spin text-primary" />;
  if (status === "success") return <CheckCircle2 className="h-4 w-4 text-primary" />;
  if (status === "failed") return <XCircle className="h-4 w-4 text-destructive" />;
  return <Clock className="h-4 w-4 text-muted-foreground" />;
}

function TaskCard({ task, onRan }: { task: Task; onRan: () => void }) {
  const [open, setOpen] = useState(false);
  const { can } = useWorkspace();
  return (
    <Card className="flex flex-col p-5">
      <div className="flex items-start gap-2">
        <FileCode className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{task.name}</div>
          {task.description && (
            <div className="mt-0.5 text-xs text-muted-foreground">{task.description}</div>
          )}
        </div>
      </div>
      <pre className="mt-3 max-h-24 overflow-hidden rounded bg-terminal p-2 font-mono text-[10px] text-terminal-foreground">
        {task.script_content}
      </pre>
      <div className="mt-4 flex justify-end">
        <Button size="sm" onClick={() => setOpen(true)} disabled={!can("member")} title={can("member") ? undefined : "Viewers can't run playbooks"}>
          <Play className="h-3.5 w-3.5" /> Run
        </Button>
      </div>
      <RunDialog open={open} onOpenChange={setOpen} task={task} onRan={onRan} />
    </Card>
  );
}

function RunDialog({ open, onOpenChange, task, onRan }: {
  open: boolean; onOpenChange: (v: boolean) => void; task: Task; onRan: () => void;
}) {
  const { user } = useAuth();
  const { current } = useWorkspace();
  const [servers, setServers] = useState<{ id: string; name: string; type: string; last_seen_at: string | null }[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!open || !current) return;
    supabase.from("servers").select("id,name,type,last_seen_at").eq("workspace_id", current.id).order("name").then(({ data }) => {
      setServers((data ?? []) as any);
    });
  }, [open, current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (id: string) => {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  };

  const run = async () => {
    if (!user || !current || selected.size === 0) return;
    setRunning(true);
    const { data: run, error: runErr } = await supabase.from("automation_runs")
      .insert({ user_id: user.id, workspace_id: current.id, task_id: task.id, status: "running" })
      .select().single();
    if (runErr || !run) { toast.error(friendlyError(runErr)); setRunning(false); return; }

    for (const sid of selected) {
      const { data: cmd, error: cmdErr } = await supabase.from("commands")
        .insert({ user_id: user.id, server_id: sid, command: task.script_content })
        .select().single();
      if (cmdErr) { toast.error("A command could not be queued for one server."); continue; }
      await supabase.from("task_logs").insert({
        user_id: user.id, run_id: run.id, server_id: sid, command_id: cmd.id, status: "pending",
      });
    }

    toast.success(`Dispatched to ${selected.size} server(s)`);
    setRunning(false);
    onOpenChange(false);
    setSelected(new Set());
    onRan();
    // route to live view
    window.location.assign(`/automation/${run.id}`);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Run: {task.name}</DialogTitle>
          <DialogDescription>Pick the target servers. The script runs via the agent on each.</DialogDescription>
        </DialogHeader>
        <div className="max-h-72 space-y-2 overflow-y-auto py-2">
          {servers.length === 0 && <div className="text-sm text-muted-foreground">No servers available.</div>}
          {servers.map((s) => {
            const online = !!s.last_seen_at && Date.now() - new Date(s.last_seen_at).getTime() < 90_000;
            return (
              <label key={s.id} className="flex cursor-pointer items-center gap-3 rounded-md border border-border/50 px-3 py-2 hover:bg-muted/30">
                <Checkbox checked={selected.has(s.id)} onCheckedChange={() => toggle(s.id)} />
                <span className={`status-dot ${online ? "bg-success text-success" : "bg-destructive text-destructive"}`} />
                <span className="flex-1 font-medium">{s.name}</span>
                <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[9px] uppercase text-muted-foreground">{s.type}</span>
              </label>
            );
          })}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={run} disabled={running || selected.size === 0}>
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            Run on {selected.size}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NewPlaybookDialog({ onCreated }: { onCreated: () => void }) {
  const { user } = useAuth();
  const { current } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [script, setScript] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !current) return;
    const { error } = await supabase.from("automation_tasks").insert({
      user_id: user.id, workspace_id: current.id, name: name.trim().slice(0, 100), description: description.trim().slice(0, 1000), script_content: script.slice(0, 20000),
    });
    if (error) toast.error(friendlyError(error));
    else {
      toast.success("Playbook saved");
      setName(""); setDescription(""); setScript("");
      setOpen(false); onCreated();
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button><Plus className="h-4 w-4" /> New playbook</Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>New playbook</DialogTitle>
            <DialogDescription>A shell script that runs on the target servers as root.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="pn">Name</Label>
              <Input id="pn" required value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="pd">Description</Label>
              <Input id="pd" value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ps">Script</Label>
              <Textarea id="ps" required rows={8} value={script} onChange={(e) => setScript(e.target.value)}
                className="font-mono text-xs" placeholder="apt-get update && apt-get -y upgrade" />
            </div>
          </div>
          <DialogFooter>
            <Button type="submit">Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
