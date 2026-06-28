import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState, useMemo } from "react";
import { RequireAuth } from "@/components/RequireAuth";
import { AppShell } from "@/components/AppShell";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { Server, Cpu, MemoryStick, AlertTriangle, Terminal, DollarSign, Cloud, HardDrive } from "lucide-react";

export const Route = createFileRoute("/overview")({
  component: () => (
    <RequireAuth>
      <AppShell>
        <Overview />
      </AppShell>
    </RequireAuth>
  ),
});

interface ServerRow {
  id: string; name: string; type: string; last_seen_at: string | null;
}
interface MetricRow {
  server_id: string; cpu_percent: number | null; memory_percent: number | null;
  disk_percent: number | null; recorded_at: string;
}

function isOnline(t: string | null) {
  return !!t && Date.now() - new Date(t).getTime() < 90_000;
}

function Overview() {
  const { user } = useAuth();
  const [servers, setServers] = useState<ServerRow[]>([]);
  const [latest, setLatest] = useState<Record<string, MetricRow>>({});
  const [activeSessions, setActiveSessions] = useState(0);
  const [mtdSpend, setMtdSpend] = useState(0);

  useEffect(() => {
    if (!user) return;
    const load = async () => {
      const { data: srv } = await supabase.from("servers")
        .select("id,name,type,last_seen_at");
      setServers((srv ?? []) as ServerRow[]);

      if (srv && srv.length) {
        const ids = srv.map((s) => s.id);
        const { data: m } = await supabase.from("metrics")
          .select("server_id,cpu_percent,memory_percent,disk_percent,recorded_at")
          .in("server_id", ids).order("recorded_at", { ascending: false }).limit(500);
        const map: Record<string, MetricRow> = {};
        for (const row of (m ?? []) as MetricRow[]) {
          if (!map[row.server_id]) map[row.server_id] = row;
        }
        setLatest(map);
      }

      const cutoff = new Date(Date.now() - 60_000).toISOString();
      const { count } = await supabase.from("terminal_sessions")
        .select("id", { count: "exact", head: true })
        .gte("last_agent_poll_at", cutoff);
      setActiveSessions(count ?? 0);

      const firstOfMonth = new Date();
      firstOfMonth.setUTCDate(1);
      firstOfMonth.setUTCHours(0, 0, 0, 0);
      const { data: costs } = await supabase.from("cost_metrics")
        .select("daily_cost")
        .gte("day", firstOfMonth.toISOString().slice(0, 10));
      setMtdSpend((costs ?? []).reduce((a, r) => a + Number(r.daily_cost ?? 0), 0));
    };
    load();
    const i = setInterval(load, 15000);
    return () => clearInterval(i);
  }, [user]);

  const stats = useMemo(() => {
    const total = servers.length;
    const online = servers.filter((s) => isOnline(s.last_seen_at)).length;
    const aws = servers.filter((s) => s.type === "aws").length;
    return { total, online, offline: total - online, aws };
  }, [servers]);

  const alerts = useMemo(() => {
    const out: { server: ServerRow; kind: string; value: number }[] = [];
    for (const s of servers) {
      const m = latest[s.id];
      if (!m) continue;
      if ((m.cpu_percent ?? 0) >= 90) out.push({ server: s, kind: "CPU", value: m.cpu_percent! });
      if ((m.memory_percent ?? 0) >= 90) out.push({ server: s, kind: "MEM", value: m.memory_percent! });
      if ((m.disk_percent ?? 0) >= 90) out.push({ server: s, kind: "DISK", value: m.disk_percent! });
    }
    return out;
  }, [servers, latest]);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-mono text-xs uppercase tracking-widest text-muted-foreground">// overview</h1>
        <h2 className="mt-1 text-3xl font-semibold tracking-tight">Mission control</h2>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Stat icon={<Server className="h-4 w-4" />} label="Servers" value={stats.total} />
        <Stat icon={<Cpu className="h-4 w-4 text-primary" />} label="Online" value={stats.online} accent="primary" />
        <Stat icon={<MemoryStick className="h-4 w-4 text-destructive" />} label="Offline" value={stats.offline} accent={stats.offline > 0 ? "destructive" : "muted"} />
        <Stat icon={<Terminal className="h-4 w-4" />} label="Active sessions" value={activeSessions} />
        <Stat icon={<Cloud className="h-4 w-4" />} label="AWS instances" value={stats.aws} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              <AlertTriangle className="h-3.5 w-3.5" /> Real-time alerts
            </div>
            <span className="font-mono text-xs text-muted-foreground">{alerts.length}</span>
          </div>
          {alerts.length === 0 ? (
            <div className="mt-6 text-sm text-muted-foreground">All systems nominal.</div>
          ) : (
            <ul className="mt-4 space-y-2">
              {alerts.map((a, i) => (
                <li key={i} className="flex items-center justify-between rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
                  <Link to="/servers/$id" params={{ id: a.server.id }} className="font-medium hover:underline">
                    {a.server.name}
                  </Link>
                  <span className="font-mono text-xs text-destructive">
                    {a.kind} {Math.round(a.value)}%
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="p-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              <DollarSign className="h-3.5 w-3.5" /> AWS spend (month-to-date)
            </div>
            <Link to="/costs" className="font-mono text-[10px] text-primary hover:underline">View →</Link>
          </div>
          <div className="mt-4 font-mono text-4xl font-semibold">
            ${mtdSpend.toFixed(2)}
          </div>
          <div className="mt-1 font-mono text-xs text-muted-foreground">
            Across {stats.aws} AWS server{stats.aws === 1 ? "" : "s"} · demo estimates
          </div>
        </Card>
      </div>

      <Card className="p-5">
        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          <HardDrive className="h-3.5 w-3.5" /> Resource snapshot
        </div>
        {servers.length === 0 ? (
          <div className="mt-6 text-sm text-muted-foreground">No servers yet. <Link to="/" className="text-primary hover:underline">Add one →</Link></div>
        ) : (
          <div className="mt-4 grid gap-2">
            {servers.map((s) => {
              const m = latest[s.id];
              const online = isOnline(s.last_seen_at);
              return (
                <Link key={s.id} to="/servers/$id" params={{ id: s.id }}
                  className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-4 rounded-md border border-border/50 px-3 py-2 hover:border-primary/30">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className={`status-dot ${online ? "bg-primary text-primary" : "bg-destructive text-destructive"}`} />
                    <span className="truncate font-medium">{s.name}</span>
                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[9px] uppercase text-muted-foreground">{s.type}</span>
                  </div>
                  <Bar label="CPU" value={m?.cpu_percent} />
                  <Bar label="MEM" value={m?.memory_percent} />
                  <Bar label="DISK" value={m?.disk_percent} />
                </Link>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

function Stat({ icon, label, value, accent }: { icon: React.ReactNode; label: string; value: number; accent?: "primary" | "destructive" | "muted" }) {
  const color = accent === "primary" ? "text-primary" : accent === "destructive" ? "text-destructive" : accent === "muted" ? "text-muted-foreground" : "text-foreground";
  return (
    <Card className="p-4">
      <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        {icon} {label}
      </div>
      <div className={`mt-1 font-mono text-3xl font-semibold ${color}`}>{value}</div>
    </Card>
  );
}

function Bar({ label, value }: { label: string; value: number | null | undefined }) {
  const v = value == null ? null : Math.round(Number(value));
  const color = v == null ? "bg-muted" : v >= 90 ? "bg-destructive" : v >= 75 ? "bg-warning" : "bg-primary";
  return (
    <div className="hidden w-24 sm:block">
      <div className="flex items-center justify-between font-mono text-[9px] uppercase text-muted-foreground">
        <span>{label}</span><span>{v == null ? "—" : `${v}%`}</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
        <div className={`h-full ${color}`} style={{ width: `${v ?? 0}%` }} />
      </div>
    </div>
  );
}
