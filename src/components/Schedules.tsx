import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useWorkspace } from "@/lib/workspace";
import { useAuth } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { CalendarClock, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { friendlyError } from "@/lib/errors";

interface Schedule {
  id: string; task_id: string; name: string; all_servers: boolean; server_ids: string[];
  frequency: string; time_of_day: string; day_of_week: number | null; day_of_month: number | null;
  timezone: string; enabled: boolean; next_run_at: string | null; last_run_at: string | null;
  last_run_id: string | null; last_result: string | null;
}
interface TaskLite { id: string; name: string }
interface ServerLite { id: string; name: string; remote_access: boolean }

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function fmt(iso: string | null, tz: string) {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: tz }).format(new Date(iso));
  } catch { return new Date(iso).toLocaleString(); }
}

function describeWhen(s: Schedule) {
  const t = s.time_of_day.slice(0, 5);
  if (s.frequency === "daily") return `Every day at ${t}`;
  if (s.frequency === "weekly") return `Every ${DAYS[s.day_of_week ?? 0]} at ${t}`;
  return `Monthly on day ${s.day_of_month} at ${t}`;
}

export function Schedules({ tasks }: { tasks: TaskLite[] }) {
  const { current, can } = useWorkspace();
  const [items, setItems] = useState<Schedule[]>([]);
  const [open, setOpen] = useState(false);
  const isAdmin = can("admin");

  const load = async () => {
    if (!current) return;
    const { data } = await supabase.from("playbook_schedules").select("*").eq("workspace_id", current.id).order("created_at", { ascending: false });
    setItems((data ?? []) as Schedule[]);
  };
  useEffect(() => { load(); }, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = async (s: Schedule) => {
    const { error } = await supabase.from("playbook_schedules").update({ enabled: !s.enabled }).eq("id", s.id);
    if (error) toast.error(friendlyError(error)); else load();
  };
  const remove = async (s: Schedule) => {
    if (!confirm(`Delete the schedule "${s.name}"?`)) return;
    const { error } = await supabase.from("playbook_schedules").delete().eq("id", s.id);
    if (error) toast.error(friendlyError(error)); else load();
  };

  if (!isAdmin && items.length === 0) return null;

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">// schedules</h3>
        {isAdmin && tasks.length > 0 && (
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}><Plus className="h-3.5 w-3.5" /> New schedule</Button>
        )}
      </div>
      {items.length === 0 ? (
        <Card className="p-6 text-center text-sm text-muted-foreground">
          No schedules yet. A schedule runs a playbook automatically, for example a weekly update.
        </Card>
      ) : (
        <Card className="divide-y divide-border/60">
          {items.map((s) => {
            const task = tasks.find((t) => t.id === s.task_id);
            return (
              <div key={s.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <CalendarClock className={`h-4 w-4 ${s.enabled ? "text-primary" : "text-muted-foreground"}`} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{s.name} <span className="text-xs font-normal text-muted-foreground">· {task?.name ?? "playbook"}</span></div>
                  <div className="text-xs text-muted-foreground">
                    {describeWhen(s)} ({s.timezone}) · {s.all_servers ? "all servers" : `${s.server_ids.length} server(s)`}
                  </div>
                  <div className="font-mono text-[11px] text-muted-foreground">
                    {s.enabled ? `next: ${fmt(s.next_run_at, s.timezone)}` : "paused"}
                    {s.last_result && <> · last: {s.last_result}{s.last_run_id && <> (<Link to="/automation/$runId" params={{ runId: s.last_run_id }} className="underline">view</Link>)</>}</>}
                  </div>
                </div>
                {isAdmin && (
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="outline" onClick={() => toggle(s)}>{s.enabled ? "Pause" : "Resume"}</Button>
                    <Button size="icon" variant="ghost" onClick={() => remove(s)} aria-label="Delete schedule"><Trash2 className="h-4 w-4" /></Button>
                  </div>
                )}
              </div>
            );
          })}
        </Card>
      )}
      {isAdmin && <NewSchedule open={open} onOpenChange={setOpen} tasks={tasks} onCreated={load} />}
    </div>
  );
}

function NewSchedule({ open, onOpenChange, tasks, onCreated }: {
  open: boolean; onOpenChange: (v: boolean) => void; tasks: TaskLite[]; onCreated: () => void;
}) {
  const { user } = useAuth();
  const { current } = useWorkspace();
  const [servers, setServers] = useState<ServerLite[]>([]);
  const [name, setName] = useState("");
  const [taskId, setTaskId] = useState("");
  const [frequency, setFrequency] = useState("weekly");
  const [time, setTime] = useState("03:00");
  const [dow, setDow] = useState(0);
  const [dom, setDom] = useState(1);
  const [tz, setTz] = useState(() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } });
  const [all, setAll] = useState(true);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !current) return;
    if (!taskId && tasks[0]) setTaskId(tasks[0].id);
    supabase.from("servers").select("id,name,remote_access").eq("workspace_id", current.id).order("name")
      .then(({ data }) => setServers((data ?? []) as ServerLite[]));
  }, [open, current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !current || !taskId) return;
    if (!all && picked.size === 0) { toast.error("Pick at least one server."); return; }
    setSaving(true);
    const { error } = await supabase.from("playbook_schedules").insert({
      workspace_id: current.id, task_id: taskId, name: name.trim().slice(0, 100) || "Scheduled playbook",
      all_servers: all, server_ids: all ? [] : [...picked],
      frequency, time_of_day: time, timezone: tz,
      day_of_week: frequency === "weekly" ? dow : null,
      day_of_month: frequency === "monthly" ? dom : null,
      created_by: user.id,
    });
    setSaving(false);
    if (error) { toast.error(friendlyError(error)); return; }
    toast.success("Schedule created");
    setName(""); onOpenChange(false); onCreated();
  };

  const sel = "h-9 w-full rounded-md border border-input bg-background px-3 text-sm";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>New schedule</DialogTitle>
            <DialogDescription>
              Runs the playbook automatically as you. Offline and monitoring-only servers are skipped and the run shows why.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] space-y-4 overflow-y-auto py-4">
            <div className="space-y-2">
              <Label htmlFor="sn">Name</Label>
              <Input id="sn" value={name} onChange={(e) => setName(e.target.value)} placeholder="Weekly updates" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="st">Playbook</Label>
              <select id="st" className={sel} value={taskId} onChange={(e) => setTaskId(e.target.value)}>
                {tasks.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="sf">How often</Label>
                <select id="sf" className={sel} value={frequency} onChange={(e) => setFrequency(e.target.value)}>
                  <option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option>
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="sh">At</Label>
                <Input id="sh" type="time" required value={time} onChange={(e) => setTime(e.target.value)} />
              </div>
            </div>
            {frequency === "weekly" && (
              <div className="space-y-2">
                <Label htmlFor="sd">Day of week</Label>
                <select id="sd" className={sel} value={dow} onChange={(e) => setDow(Number(e.target.value))}>
                  {DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
                </select>
              </div>
            )}
            {frequency === "monthly" && (
              <div className="space-y-2">
                <Label htmlFor="sm">Day of month (1–28)</Label>
                <Input id="sm" type="number" min={1} max={28} value={dom} onChange={(e) => setDom(Math.min(28, Math.max(1, Number(e.target.value) || 1)))} />
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="sz">Time zone</Label>
              <Input id="sz" value={tz} onChange={(e) => setTz(e.target.value)} placeholder="Europe/London" />
              <p className="text-xs text-muted-foreground">Uses names like America/New_York. Daylight saving is handled for you.</p>
            </div>
            <div className="space-y-2">
              <Label>Servers</Label>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={all} onCheckedChange={(v) => setAll(!!v)} /> All servers in this team (including ones added later)
              </label>
              {!all && (
                <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-border/50 p-2">
                  {servers.map((s) => (
                    <label key={s.id} className="flex items-center gap-2 text-sm">
                      <Checkbox checked={picked.has(s.id)} onCheckedChange={() => {
                        const n = new Set(picked); n.has(s.id) ? n.delete(s.id) : n.add(s.id); setPicked(n);
                      }} />
                      {s.name}
                      {s.remote_access === false && <span className="font-mono text-[9px] uppercase text-warning">monitoring only</span>}
                    </label>
                  ))}
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={saving || !taskId}>Create schedule</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
