import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { useEffect, useState, useMemo } from "react";
import { RequireAuth } from "@/components/RequireAuth";
import { AppShell } from "@/components/AppShell";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ArrowLeft, Cpu, HardDrive, MemoryStick, Network, Play, RefreshCw, Terminal as TermIcon, Zap, Clock } from "lucide-react";
import {
  Area,
  AreaChart,
  Brush,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  type TooltipProps,
  XAxis,
  YAxis,
} from "recharts";
import { toast } from "sonner";

export const Route = createFileRoute("/servers/$id")({
  head: () => ({
    meta: [{ title: "Server detail — Fleet" }],
  }),
  component: () => (
    <RequireAuth>
      <AppShell>
        <ServerDetail />
      </AppShell>
    </RequireAuth>
  ),
});

interface ServerRow {
  id: string;
  name: string;
  hostname: string | null;
  ip_address: string | null;
  os: string | null;
  tags: string[];
  agent_token: string;
  last_seen_at: string | null;
}

interface MetricRow {
  recorded_at: string;
  cpu_percent: number | null;
  memory_percent: number | null;
  memory_used_mb: number | null;
  memory_total_mb: number | null;
  disk_percent: number | null;
  disk_used_gb: number | null;
  disk_total_gb: number | null;
  net_rx_kbs: number | null;
  net_tx_kbs: number | null;
  load_1: number | null;
  uptime_seconds: number | null;
}

interface CommandRow {
  id: string;
  command: string;
  status: "pending" | "running" | "completed" | "failed";
  exit_code: number | null;
  stdout: string | null;
  stderr: string | null;
  created_at: string;
  completed_at: string | null;
}

const PRESETS = [
  { label: "apt update + upgrade", cmd: "DEBIAN_FRONTEND=noninteractive apt-get update && DEBIAN_FRONTEND=noninteractive apt-get -y upgrade" },
  { label: "dnf upgrade", cmd: "dnf -y upgrade" },
  { label: "Disk usage", cmd: "df -h" },
  { label: "Top processes", cmd: "ps aux --sort=-%cpu | head -15" },
  { label: "Reboot", cmd: "reboot" },
];

function ServerDetail() {
  const { id } = useParams({ from: "/servers/$id" });
  const { user } = useAuth();
  const [server, setServer] = useState<ServerRow | null>(null);
  const [metrics, setMetrics] = useState<MetricRow[]>([]);
  const [commands, setCommands] = useState<CommandRow[]>([]);
  const [cmdInput, setCmdInput] = useState("");
  const [running, setRunning] = useState(false);

  const loadAll = async () => {
    if (!user) return;
    const [{ data: s }, { data: m }, { data: c }] = await Promise.all([
      supabase.from("servers").select("*").eq("id", id).single(),
      supabase
        .from("metrics")
        .select("*")
        .eq("server_id", id)
        .gte("recorded_at", new Date(Date.now() - 60 * 60 * 1000).toISOString())
        .order("recorded_at", { ascending: true }),
      supabase
        .from("commands")
        .select("*")
        .eq("server_id", id)
        .order("created_at", { ascending: false })
        .limit(20),
    ]);
    if (s) setServer(s as ServerRow);
    setMetrics((m ?? []) as MetricRow[]);
    setCommands((c ?? []) as CommandRow[]);
  };

  useEffect(() => {
    loadAll();
    const i = setInterval(loadAll, 8000);
    return () => clearInterval(i);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, user]);

  const latest = metrics[metrics.length - 1];
  const online = server?.last_seen_at && Date.now() - new Date(server.last_seen_at).getTime() < 90_000;

  const chartData = useMemo(() =>
    metrics.map((m) => ({
      t: new Date(m.recorded_at).getTime(),
      label: new Date(m.recorded_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      cpu: m.cpu_percent == null ? null : Number(m.cpu_percent),
      mem: m.memory_percent == null ? null : Number(m.memory_percent),
      disk: m.disk_percent == null ? null : Number(m.disk_percent),
      rx: m.net_rx_kbs == null ? null : Number(m.net_rx_kbs),
      tx: m.net_tx_kbs == null ? null : Number(m.net_tx_kbs),
    })),
  [metrics]);

  const submitCommand = async (cmd: string) => {
    if (!user || !cmd.trim()) return;
    setRunning(true);
    const { error } = await supabase.from("commands").insert({
      user_id: user.id,
      server_id: id,
      command: cmd,
    });
    setRunning(false);
    if (error) toast.error(error.message);
    else {
      toast.success("Queued — agent will pick it up within 10s");
      setCmdInput("");
      loadAll();
    }
  };

  if (!server) {
    return <div className="text-sm text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="space-y-8">
      <div>
        <Link to="/" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" /> All servers
        </Link>
        <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <span className={`status-dot ${online ? "bg-primary text-primary" : "bg-destructive text-destructive"}`} />
              <h1 className="text-3xl font-semibold tracking-tight">{server.name}</h1>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-3 font-mono text-xs text-muted-foreground">
              <span>{server.hostname || "no hostname"}</span>
              {server.ip_address && <span>· {server.ip_address}</span>}
              {server.os && <span>· {server.os}</span>}
              {server.last_seen_at && (
                <span className="inline-flex items-center gap-1">
                  <Clock className="h-3 w-3" /> last seen {timeAgo(server.last_seen_at)}
                </span>
              )}
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={loadAll}>
            <RefreshCw className="h-4 w-4" /> Refresh
          </Button>
        </div>
      </div>

      {/* Live tiles */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Tile icon={<Cpu className="h-4 w-4" />} label="CPU" value={fmtPct(latest?.cpu_percent)} sub={latest?.load_1 != null ? `load ${Number(latest.load_1).toFixed(2)}` : undefined} />
        <Tile icon={<MemoryStick className="h-4 w-4" />} label="Memory" value={fmtPct(latest?.memory_percent)} sub={latest?.memory_used_mb != null && latest?.memory_total_mb != null ? `${fmtMb(latest.memory_used_mb)} / ${fmtMb(latest.memory_total_mb)}` : undefined} />
        <Tile icon={<HardDrive className="h-4 w-4" />} label="Disk" value={fmtPct(latest?.disk_percent)} sub={latest?.disk_used_gb != null && latest?.disk_total_gb != null ? `${Number(latest.disk_used_gb).toFixed(1)}G / ${Number(latest.disk_total_gb).toFixed(1)}G` : undefined} />
        <Tile icon={<Network className="h-4 w-4" />} label="Network" value={latest?.net_rx_kbs != null ? `${Math.round(Number(latest.net_rx_kbs))} kB/s` : "—"} sub={latest?.net_tx_kbs != null ? `↑ ${Math.round(Number(latest.net_tx_kbs))} kB/s` : undefined} />
      </div>

      <Tabs defaultValue="charts">
        <TabsList>
          <TabsTrigger value="charts">Charts</TabsTrigger>
          <TabsTrigger value="commands">Commands</TabsTrigger>
        </TabsList>

        <TabsContent value="charts" className="mt-6 space-y-4">
          <Card className="p-5">
            <div className="mb-3 flex items-center justify-between">
              <div className="font-mono text-xs uppercase tracking-widest text-muted-foreground">CPU / Memory / Disk · last hour</div>
            </div>
            <div className="h-64">
              <ResponsiveContainer>
                <AreaChart data={chartData} margin={{ left: -10, right: 10, top: 5, bottom: 0 }}>
                  <defs>
                    <linearGradient id="g-cpu" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="oklch(0.78 0.18 145)" stopOpacity={0.5} />
                      <stop offset="100%" stopColor="oklch(0.78 0.18 145)" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="g-mem" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="oklch(0.7 0.18 220)" stopOpacity={0.5} />
                      <stop offset="100%" stopColor="oklch(0.7 0.18 220)" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="g-disk" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="oklch(0.82 0.17 75)" stopOpacity={0.5} />
                      <stop offset="100%" stopColor="oklch(0.82 0.17 75)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="oklch(0.3 0.02 250)" strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="label" stroke="oklch(0.65 0.02 250)" fontSize={10} tickLine={false} axisLine={false} minTickGap={40} />
                  <YAxis stroke="oklch(0.65 0.02 250)" fontSize={10} tickLine={false} axisLine={false} domain={[0, 100]} unit="%" width={40} />
                  <Tooltip contentStyle={{ background: "oklch(0.22 0.018 250)", border: "1px solid oklch(0.3 0.02 250)", borderRadius: 8, fontSize: 12 }} />
                  <Area type="monotone" dataKey="cpu" name="CPU %" stroke="oklch(0.78 0.18 145)" strokeWidth={2} fill="url(#g-cpu)" />
                  <Area type="monotone" dataKey="mem" name="Memory %" stroke="oklch(0.7 0.18 220)" strokeWidth={2} fill="url(#g-mem)" />
                  <Area type="monotone" dataKey="disk" name="Disk %" stroke="oklch(0.82 0.17 75)" strokeWidth={2} fill="url(#g-disk)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Card>

          <Card className="p-5">
            <div className="mb-3 font-mono text-xs uppercase tracking-widest text-muted-foreground">Network · last hour</div>
            <div className="h-48">
              <ResponsiveContainer>
                <AreaChart data={chartData} margin={{ left: -10, right: 10, top: 5, bottom: 0 }}>
                  <CartesianGrid stroke="oklch(0.3 0.02 250)" strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="label" stroke="oklch(0.65 0.02 250)" fontSize={10} tickLine={false} axisLine={false} minTickGap={40} />
                  <YAxis stroke="oklch(0.65 0.02 250)" fontSize={10} tickLine={false} axisLine={false} width={50} unit=" kB" />
                  <Tooltip contentStyle={{ background: "oklch(0.22 0.018 250)", border: "1px solid oklch(0.3 0.02 250)", borderRadius: 8, fontSize: 12 }} />
                  <Area type="monotone" dataKey="rx" name="Rx kB/s" stroke="oklch(0.7 0.16 300)" strokeWidth={2} fill="oklch(0.7 0.16 300 / 0.2)" />
                  <Area type="monotone" dataKey="tx" name="Tx kB/s" stroke="oklch(0.65 0.22 25)" strokeWidth={2} fill="oklch(0.65 0.22 25 / 0.2)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Card>
        </TabsContent>

        <TabsContent value="commands" className="mt-6 space-y-4">
          <Card className="p-5">
            <div className="mb-3 flex items-center gap-2 font-mono text-xs uppercase tracking-widest text-muted-foreground">
              <TermIcon className="h-3.5 w-3.5" /> Run command
            </div>
            <div className="flex flex-col gap-3">
              <div className="flex gap-2">
                <div className="flex flex-1 items-center gap-2 rounded-md border border-border bg-terminal px-3 font-mono text-sm">
                  <span className="text-primary">$</span>
                  <Input
                    value={cmdInput}
                    onChange={(e) => setCmdInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") submitCommand(cmdInput); }}
                    placeholder="uname -a"
                    className="border-0 bg-transparent font-mono text-terminal-foreground shadow-none focus-visible:ring-0"
                  />
                </div>
                <Button onClick={() => submitCommand(cmdInput)} disabled={running || !cmdInput.trim()}>
                  <Play className="h-4 w-4" /> Run
                </Button>
              </div>
              <div className="flex flex-wrap gap-2">
                {PRESETS.map((p) => (
                  <Button key={p.label} size="sm" variant="secondary" onClick={() => submitCommand(p.cmd)} disabled={running}>
                    <Zap className="h-3.5 w-3.5" /> {p.label}
                  </Button>
                ))}
              </div>
              {!online && (
                <p className="text-xs text-warning">
                  Server is offline — command will queue and run when the agent reconnects.
                </p>
              )}
            </div>
          </Card>

          <div className="space-y-3">
            {commands.length === 0 && (
              <div className="text-sm text-muted-foreground">No commands yet.</div>
            )}
            {commands.map((c) => <CommandLog key={c.id} c={c} />)}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function CommandLog({ c }: { c: CommandRow }) {
  const statusColor =
    c.status === "completed" ? "text-primary" :
    c.status === "failed" ? "text-destructive" :
    c.status === "running" ? "text-warning" : "text-muted-foreground";
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-2">
        <div className="flex min-w-0 items-center gap-2 font-mono text-xs">
          <span className="text-primary">$</span>
          <span className="truncate">{c.command}</span>
        </div>
        <div className="flex flex-none items-center gap-3 font-mono text-[10px] uppercase">
          <span className={statusColor}>{c.status}</span>
          {c.exit_code != null && <span className="text-muted-foreground">exit {c.exit_code}</span>}
          <span className="text-muted-foreground">{timeAgo(c.created_at)}</span>
        </div>
      </div>
      {(c.stdout || c.stderr) && (
        <pre className="max-h-72 overflow-auto bg-terminal p-4 font-mono text-xs leading-relaxed text-terminal-foreground">
{c.stdout}{c.stderr ? `\n[stderr]\n${c.stderr}` : ""}
        </pre>
      )}
    </Card>
  );
}

function Tile({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string; sub?: string }) {
  return (
    <Card className="p-5">
      <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        {icon} {label}
      </div>
      <div className="mt-2 font-mono text-2xl font-semibold">{value}</div>
      {sub && <div className="mt-0.5 font-mono text-xs text-muted-foreground">{sub}</div>}
    </Card>
  );
}

function fmtPct(v: number | null | undefined) {
  if (v == null) return "—";
  return `${Math.round(Number(v))}%`;
}
function fmtMb(v: number) {
  const n = Number(v);
  if (n >= 1024) return `${(n / 1024).toFixed(1)}G`;
  return `${Math.round(n)}M`;
}
function timeAgo(iso: string) {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
