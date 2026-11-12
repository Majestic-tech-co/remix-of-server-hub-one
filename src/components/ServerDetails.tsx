import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, FileText } from "lucide-react";
import { toast } from "sonner";
import { friendlyError } from "@/lib/errors";

interface Snapshot {
  services: { name: string; active: string; sub: string; description?: string }[];
  containers: { name: string; image: string; state: string; status: string }[];
  processes: { pid: number; user: string; cpu: number; mem: number; name: string }[];
  docker?: boolean;
  collected_at?: string;
}

// Only plain unit/container names reach a command: no spaces, quotes or leading dashes.
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9@:._-]{0,127}$/;

export function ServerDetails({ serverId, canRun }: { serverId: string; canRun: boolean }) {
  const { user } = useAuth();
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");
  const [log, setLog] = useState<{ title: string; text: string; pending: boolean } | null>(null);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const { data } = await supabase.from("server_snapshots").select("data,updated_at").eq("server_id", serverId).maybeSingle();
      if (!alive) return;
      setSnap((data?.data as unknown as Snapshot) ?? null);
      setUpdatedAt(data?.updated_at ?? null);
      setLoading(false);
    };
    load();
    const i = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(i); if (poll.current) clearInterval(poll.current); };
  }, [serverId]);

  const showLogs = async (kind: "service" | "container", name: string) => {
    if (!user || !SAFE_NAME.test(name)) { toast.error("That name can't be used for logs."); return; }
    const command = kind === "service"
      ? `journalctl -u ${name} -n 200 --no-pager`
      : `docker logs --tail 200 ${name} 2>&1`;
    if (poll.current) clearInterval(poll.current);
    setLog({ title: `${name} (last 200 lines)`, text: "", pending: true });
    const { data: cmd, error } = await supabase.from("commands")
      .insert({ user_id: user.id, server_id: serverId, command }).select("id").single();
    if (error || !cmd) { toast.error(friendlyError(error)); setLog(null); return; }
    let tries = 0;
    poll.current = setInterval(async () => {
      tries++;
      const { data: c } = await supabase.from("commands").select("status,stdout,stderr").eq("id", cmd.id).maybeSingle();
      if (c && (c.status === "completed" || c.status === "failed")) {
        if (poll.current) clearInterval(poll.current);
        setLog({ title: `${name} (last 200 lines)`, text: [c.stdout, c.stderr].filter(Boolean).join("\n") || "(no output)", pending: false });
      } else if (tries > 40) {
        if (poll.current) clearInterval(poll.current);
        setLog({ title: `${name}`, text: "The server didn't answer in time. It may be offline.", pending: false });
      }
    }, 1500);
  };

  if (loading) return <div className="text-sm text-muted-foreground">Loading…</div>;
  if (!snap) {
    return (
      <Card className="p-8 text-center text-sm text-muted-foreground">
        No details yet. They appear about a minute after the agent is installed or updated.
        If this server was added before this feature, run the install command on it once more.
      </Card>
    );
  }

  const q = filter.trim().toLowerCase();
  const services = snap.services.filter((s) => !q || s.name.toLowerCase().includes(q));
  const failed = snap.services.filter((s) => s.active === "failed").length;
  const stale = updatedAt && Date.now() - new Date(updatedAt).getTime() > 5 * 60_000;

  return (
    <div className="space-y-6">
      <div className="font-mono text-[11px] text-muted-foreground">
        updated {updatedAt ? new Date(updatedAt).toLocaleTimeString() : "—"}
        {stale && <span className="ml-2 text-warning">· out of date, the server may be offline</span>}
        {failed > 0 && <span className="ml-2 text-destructive">· {failed} failed service{failed > 1 ? "s" : ""}</span>}
      </div>

      <section>
        <div className="mb-2 flex items-center justify-between gap-3">
          <h3 className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">// services ({snap.services.length})</h3>
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter…" aria-label="Filter services"
            className="h-8 w-40 rounded-md border border-input bg-background px-2 text-sm" />
        </div>
        <Card className="max-h-80 divide-y divide-border/60 overflow-y-auto">
          {services.length === 0 && <div className="p-4 text-sm text-muted-foreground">Nothing matches.</div>}
          {services.map((s) => (
            <div key={s.name} className="flex items-center gap-3 px-4 py-2 text-sm">
              <span className={`status-dot ${s.active === "failed" ? "bg-destructive text-destructive" : s.sub === "running" ? "bg-success text-success" : "bg-muted-foreground text-muted-foreground"}`} />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{s.name}</div>
                {s.description && <div className="truncate text-xs text-muted-foreground">{s.description}</div>}
              </div>
              <span className="font-mono text-[10px] uppercase text-muted-foreground">{s.active === "failed" ? "failed" : s.sub}</span>
              {canRun && SAFE_NAME.test(s.name) && (
                <Button size="sm" variant="ghost" onClick={() => showLogs("service", s.name)} aria-label={`Logs for ${s.name}`}>
                  <FileText className="h-3.5 w-3.5" /> Logs
                </Button>
              )}
            </div>
          ))}
        </Card>
      </section>

      {snap.docker && (
        <section>
          <h3 className="mb-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">// containers ({snap.containers.length})</h3>
          <Card className="divide-y divide-border/60">
            {snap.containers.length === 0 && <div className="p-4 text-sm text-muted-foreground">No containers.</div>}
            {snap.containers.map((c) => (
              <div key={c.name} className="flex items-center gap-3 px-4 py-2 text-sm">
                <span className={`status-dot ${c.state === "running" ? "bg-success text-success" : "bg-muted-foreground text-muted-foreground"}`} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{c.name}</div>
                  <div className="truncate text-xs text-muted-foreground">{c.image} · {c.status}</div>
                </div>
                {canRun && SAFE_NAME.test(c.name) && (
                  <Button size="sm" variant="ghost" onClick={() => showLogs("container", c.name)} aria-label={`Logs for ${c.name}`}>
                    <FileText className="h-3.5 w-3.5" /> Logs
                  </Button>
                )}
              </div>
            ))}
          </Card>
        </section>
      )}

      <section>
        <h3 className="mb-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">// busiest processes</h3>
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left font-mono text-[10px] uppercase text-muted-foreground">
              <th className="px-4 py-2">Process</th><th className="px-2 py-2">User</th><th className="px-2 py-2 text-right">CPU %</th><th className="px-4 py-2 text-right">Memory %</th>
            </tr></thead>
            <tbody className="divide-y divide-border/60">
              {snap.processes.map((p) => (
                <tr key={p.pid}>
                  <td className="px-4 py-1.5">{p.name} <span className="font-mono text-[10px] text-muted-foreground">{p.pid}</span></td>
                  <td className="px-2 py-1.5 text-muted-foreground">{p.user}</td>
                  <td className="px-2 py-1.5 text-right font-mono">{p.cpu.toFixed(1)}</td>
                  <td className="px-4 py-1.5 text-right font-mono">{p.mem.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </section>

      {log && (
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">// logs: {log.title}</h3>
            <Button size="sm" variant="ghost" onClick={() => { if (poll.current) clearInterval(poll.current); setLog(null); }}>Close</Button>
          </div>
          <pre className="max-h-96 overflow-auto rounded-md bg-terminal p-4 font-mono text-xs text-terminal-foreground">
            {log.pending ? <span className="inline-flex items-center gap-2"><Loader2 className="h-3 w-3 animate-spin" /> Asking the server…</span> : log.text}
          </pre>
        </section>
      )}
    </div>
  );
}
