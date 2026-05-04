import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { useEffect, useState, useMemo, useRef } from "react";
import { RequireAuth } from "@/components/RequireAuth";
import { AppShell } from "@/components/AppShell";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ArrowLeft, Cpu, HardDrive, MemoryStick, Network, RefreshCw, Terminal as TermIcon, Clock } from "lucide-react";
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
  started_at: string | null;
  completed_at: string | null;
}

const PRESETS = [
  { label: "apt upgrade", cmd: "DEBIAN_FRONTEND=noninteractive apt-get update && DEBIAN_FRONTEND=noninteractive apt-get -y upgrade" },
  { label: "dnf upgrade", cmd: "dnf -y upgrade" },
  { label: "df -h", cmd: "df -h" },
  { label: "free -h", cmd: "free -h" },
  { label: "top procs", cmd: "ps aux --sort=-%cpu | head -15" },
  { label: "uptime", cmd: "uptime" },
  { label: "journal -50", cmd: "journalctl -n 50 --no-pager" },
  { label: "reboot (1m)", cmd: "shutdown -r +1 'Fleet: scheduled reboot — cancel with: shutdown -c'" },
];

// Commands the UI asks the user to confirm before sending.
const DANGEROUS = [
  /\breboot\b/i,
  /\bshutdown\b/i,
  /\bhalt\b/i,
  /\bpoweroff\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\brm\s+-rf?\s+\/(?!\S*tmp)/i,
  /:\(\)\s*\{.*\};:/,
  /\bsystemctl\s+(stop|disable|mask)\s+fleet-agent\b/i,
];
function isDangerous(cmd: string) {
  return DANGEROUS.some((r) => r.test(cmd));
}

function ServerDetail() {
  const { id } = useParams({ from: "/servers/$id" });
  const { user } = useAuth();
  const [server, setServer] = useState<ServerRow | null>(null);
  const [metrics, setMetrics] = useState<MetricRow[]>([]);
  const [commands, setCommands] = useState<CommandRow[]>([]);
  const [cmdInput, setCmdInput] = useState("");
  const [running, setRunning] = useState(false);
  const [rangeMin, setRangeMin] = useState<number>(60);

  const loadAll = async () => {
    if (!user) return;
    const since = new Date(Date.now() - rangeMin * 60 * 1000).toISOString();
    const [{ data: s }, { data: m }, { data: c }] = await Promise.all([
      supabase.from("servers").select("*").eq("id", id).single(),
      supabase
        .from("metrics")
        .select("*")
        .eq("server_id", id)
        .gte("recorded_at", since)
        .order("recorded_at", { ascending: true })
        .limit(5000),
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
  }, [id, user, rangeMin]);

  const latest = metrics[metrics.length - 1];
  const online = server?.last_seen_at && Date.now() - new Date(server.last_seen_at).getTime() < 90_000;

  // Real timestamp x-axis with gap detection. If two consecutive samples are
  // farther apart than 3× the median interval, insert a null point so charts
  // visibly break instead of interpolating across missing data.
  const chartData = useMemo(() => {
    if (metrics.length === 0) return [] as ChartPoint[];
    const points: ChartPoint[] = metrics.map((m) => ({
      t: new Date(m.recorded_at).getTime(),
      cpu: m.cpu_percent == null ? null : Number(m.cpu_percent),
      mem: m.memory_percent == null ? null : Number(m.memory_percent),
      memUsed: m.memory_used_mb == null ? null : Number(m.memory_used_mb),
      disk: m.disk_percent == null ? null : Number(m.disk_percent),
      diskUsed: m.disk_used_gb == null ? null : Number(m.disk_used_gb),
      rx: m.net_rx_kbs == null ? null : Number(m.net_rx_kbs),
      tx: m.net_tx_kbs == null ? null : Number(m.net_tx_kbs),
      load: m.load_1 == null ? null : Number(m.load_1),
    }));
    const deltas: number[] = [];
    for (let i = 1; i < points.length; i++) deltas.push(points[i].t - points[i - 1].t);
    deltas.sort((a, b) => a - b);
    const median = deltas.length ? deltas[Math.floor(deltas.length / 2)] : 60_000;
    const gap = Math.max(median * 3, 90_000);
    const out: ChartPoint[] = [];
    for (let i = 0; i < points.length; i++) {
      if (i > 0 && points[i].t - points[i - 1].t > gap) {
        out.push({ t: points[i - 1].t + 1, cpu: null, mem: null, memUsed: null, disk: null, diskUsed: null, rx: null, tx: null, load: null });
      }
      out.push(points[i]);
    }
    return out;
  }, [metrics]);

  const domain = useMemo<[number, number]>(() => {
    const end = Date.now();
    return [end - rangeMin * 60 * 1000, end];
  }, [rangeMin, metrics.length]);

  const ticks = useMemo(() => makeTicks(domain[0], domain[1], 6), [domain]);

  const submitCommand = async (cmd: string) => {
    if (!user || !cmd.trim()) return;
    if (isDangerous(cmd)) {
      const ok = window.confirm(
        `This command looks destructive:\n\n  ${cmd}\n\nRun it on "${server?.name ?? "this server"}"?`,
      );
      if (!ok) return;
    }
    setRunning(true);
    const { error } = await supabase.from("commands").insert({
      user_id: user.id,
      server_id: id,
      command: cmd,
    });
    setRunning(false);
    if (error) toast.error(error.message);
    else {
      toast.success("Queued — agent will pick it up within 15s");
      setCmdInput("");
      loadAll();
    }
  };

  if (!server) {
    return <div className="text-sm text-muted-foreground">Loading…</div>;
  }

  const ranges = [
    { label: "15m", min: 15 },
    { label: "1h", min: 60 },
    { label: "6h", min: 360 },
    { label: "24h", min: 1440 },
    { label: "7d", min: 60 * 24 * 7 },
  ];

  const memTotalMb = latest?.memory_total_mb ? Number(latest.memory_total_mb) : null;
  const diskTotalGb = latest?.disk_total_gb ? Number(latest.disk_total_gb) : null;

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
              <span>· {metrics.length} samples</span>
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={loadAll}>
            <RefreshCw className="h-4 w-4" /> Refresh
          </Button>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Tile icon={<Cpu className="h-4 w-4" />} label="CPU" value={fmtPct(latest?.cpu_percent)} sub={latest?.load_1 != null ? `load ${Number(latest.load_1).toFixed(2)}` : undefined} />
        <Tile icon={<MemoryStick className="h-4 w-4" />} label="Memory" value={fmtPct(latest?.memory_percent)} sub={latest?.memory_used_mb != null && latest?.memory_total_mb != null ? `${fmtMb(latest.memory_used_mb)} / ${fmtMb(latest.memory_total_mb)}` : undefined} />
        <Tile icon={<HardDrive className="h-4 w-4" />} label="Disk" value={fmtPct(latest?.disk_percent)} sub={latest?.disk_used_gb != null && latest?.disk_total_gb != null ? `${Number(latest.disk_used_gb).toFixed(1)}G / ${Number(latest.disk_total_gb).toFixed(1)}G` : undefined} />
        <Tile icon={<Network className="h-4 w-4" />} label="Network" value={latest?.net_rx_kbs != null ? fmtKbps(Number(latest.net_rx_kbs)) : "—"} sub={latest?.net_tx_kbs != null ? `↑ ${fmtKbps(Number(latest.net_tx_kbs))}` : undefined} />
      </div>

      <Tabs defaultValue="charts">
        <TabsList>
          <TabsTrigger value="charts">Charts</TabsTrigger>
          <TabsTrigger value="commands">Commands</TabsTrigger>
        </TabsList>

        <TabsContent value="charts" className="mt-6 space-y-4">
          <div className="flex flex-wrap items-center gap-1 rounded-md border border-border p-1 w-fit">
            {ranges.map((r) => (
              <button
                key={r.label}
                onClick={() => setRangeMin(r.min)}
                className={`rounded px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider transition-colors ${
                  rangeMin === r.min ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>

          <ChartCard title={`CPU · last ${labelFor(rangeMin)}`}>
            <ResponsiveContainer>
              <AreaChart data={chartData} margin={{ left: 0, right: 12, top: 8, bottom: 0 }}>
                <defs>
                  <linearGradient id="g-cpu" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="oklch(0.78 0.18 145)" stopOpacity={0.45} />
                    <stop offset="100%" stopColor="oklch(0.78 0.18 145)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                {commonGrid()}
                <XAxis {...xAxisProps(domain, ticks)} />
                <YAxis {...yAxisProps()} domain={[0, 100]} unit="%" width={42} />
                <Tooltip content={<DetailTooltip unit="%" />} />
                <Area type="linear" dataKey="cpu" name="CPU" stroke="oklch(0.78 0.18 145)" strokeWidth={1.5} fill="url(#g-cpu)" isAnimationActive={false} dot={false} connectNulls={false} />
                <Brush dataKey="t" height={20} travellerWidth={8} stroke="oklch(0.4 0.02 250)" fill="oklch(0.18 0.018 250)" tickFormatter={(v) => fmtTimeShort(Number(v))} />
              </AreaChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard title="Load average (1m)">
            <ResponsiveContainer>
              <LineChart data={chartData} margin={{ left: 0, right: 12, top: 8, bottom: 0 }}>
                {commonGrid()}
                <XAxis {...xAxisProps(domain, ticks)} />
                <YAxis {...yAxisProps()} width={42} domain={[0, "auto"]} />
                <Tooltip content={<DetailTooltip />} />
                <Line type="linear" dataKey="load" name="Load" stroke="oklch(0.75 0.18 60)" strokeWidth={1.5} dot={false} isAnimationActive={false} connectNulls={false} />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard title={`Memory${memTotalMb ? ` · ${fmtMb(memTotalMb)} total` : ""}`}>
            <ResponsiveContainer>
              <AreaChart data={chartData} margin={{ left: 0, right: 12, top: 8, bottom: 0 }}>
                <defs>
                  <linearGradient id="g-mem" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="oklch(0.7 0.18 220)" stopOpacity={0.45} />
                    <stop offset="100%" stopColor="oklch(0.7 0.18 220)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                {commonGrid()}
                <XAxis {...xAxisProps(domain, ticks)} />
                <YAxis {...yAxisProps()} width={56} domain={[0, memTotalMb ?? "auto"]} tickFormatter={(v) => fmtMb(Number(v))} />
                <Tooltip content={<DetailTooltip valueFormatter={(v) => fmtMb(v)} />} />
                <Area type="linear" dataKey="memUsed" name="Used" stroke="oklch(0.7 0.18 220)" strokeWidth={1.5} fill="url(#g-mem)" isAnimationActive={false} dot={false} connectNulls={false} />
              </AreaChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard title={`Disk${diskTotalGb ? ` · ${diskTotalGb.toFixed(1)} GB total` : ""}`}>
            <ResponsiveContainer>
              <AreaChart data={chartData} margin={{ left: 0, right: 12, top: 8, bottom: 0 }}>
                <defs>
                  <linearGradient id="g-disk" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="oklch(0.82 0.17 75)" stopOpacity={0.45} />
                    <stop offset="100%" stopColor="oklch(0.82 0.17 75)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                {commonGrid()}
                <XAxis {...xAxisProps(domain, ticks)} />
                <YAxis {...yAxisProps()} width={52} domain={[0, diskTotalGb ?? "auto"]} tickFormatter={(v) => `${Number(v).toFixed(0)}G`} />
                <Tooltip content={<DetailTooltip valueFormatter={(v) => `${v.toFixed(2)} GB`} />} />
                <Area type="linear" dataKey="diskUsed" name="Used" stroke="oklch(0.82 0.17 75)" strokeWidth={1.5} fill="url(#g-disk)" isAnimationActive={false} dot={false} connectNulls={false} />
              </AreaChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard title="Network throughput">
            <ResponsiveContainer>
              <LineChart data={chartData} margin={{ left: 0, right: 12, top: 8, bottom: 0 }}>
                {commonGrid()}
                <XAxis {...xAxisProps(domain, ticks)} />
                <YAxis {...yAxisProps()} width={68} tickFormatter={(v) => fmtKbps(Number(v))} domain={[0, "auto"]} />
                <Tooltip content={<DetailTooltip valueFormatter={(v) => fmtKbps(v)} />} />
                <Line type="linear" dataKey="rx" name="↓ Rx" stroke="oklch(0.7 0.16 300)" strokeWidth={1.5} dot={false} isAnimationActive={false} connectNulls={false} />
                <Line type="linear" dataKey="tx" name="↑ Tx" stroke="oklch(0.65 0.22 25)" strokeWidth={1.5} dot={false} isAnimationActive={false} connectNulls={false} />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>
        </TabsContent>

        <TabsContent value="commands" className="mt-6">
          <Terminal
            serverName={server.hostname || server.name}
            online={!!online}
            commands={commands}
            onSubmit={submitCommand}
            running={running}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

interface ChartPoint {
  t: number;
  cpu: number | null;
  mem: number | null;
  memUsed: number | null;
  disk: number | null;
  diskUsed: number | null;
  rx: number | null;
  tx: number | null;
  load: number | null;
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="p-5">
      <div className="mb-3 font-mono text-xs uppercase tracking-widest text-muted-foreground">{title}</div>
      <div className="h-56">{children}</div>
    </Card>
  );
}

function commonGrid() {
  return <CartesianGrid stroke="oklch(0.3 0.02 250)" strokeDasharray="3 3" vertical={false} />;
}

function xAxisProps(domain: [number, number], ticks: number[]) {
  return {
    dataKey: "t" as const,
    type: "number" as const,
    scale: "time" as const,
    domain,
    ticks,
    stroke: "oklch(0.65 0.02 250)",
    fontSize: 10,
    tickLine: false,
    axisLine: false,
    tickFormatter: (v: number) => fmtTickFor(domain, v),
    minTickGap: 24,
  };
}

function yAxisProps() {
  return {
    stroke: "oklch(0.65 0.02 250)",
    fontSize: 10,
    tickLine: false,
    axisLine: false,
  };
}

function DetailTooltip({
  active,
  payload,
  label,
  unit,
  valueFormatter,
}: TooltipProps<number, string> & { unit?: string; valueFormatter?: (v: number) => string }) {
  if (!active || !payload || payload.length === 0) return null;
  const t = typeof label === "number" ? label : Number(label);
  return (
    <div className="rounded-md border border-border/60 bg-background/95 px-3 py-2 font-mono text-[11px] shadow-xl backdrop-blur">
      <div className="mb-1 text-muted-foreground">{fmtTimeFull(t)}</div>
      {payload.map((p) => {
        const v = p.value as number | null | undefined;
        if (v == null) return null;
        const formatted = valueFormatter ? valueFormatter(Number(v)) : `${Number(v).toFixed(2)}${unit ?? ""}`;
        return (
          <div key={String(p.dataKey)} className="flex items-center gap-2">
            <span className="inline-block h-2 w-2 rounded-sm" style={{ background: p.color }} />
            <span className="text-muted-foreground">{p.name}</span>
            <span className="ml-auto tabular-nums text-foreground">{formatted}</span>
          </div>
        );
      })}
    </div>
  );
}

function makeTicks(start: number, end: number, count: number) {
  const step = (end - start) / count;
  const out: number[] = [];
  for (let i = 0; i <= count; i++) out.push(Math.round(start + step * i));
  return out;
}

function fmtTickFor(domain: [number, number], v: number) {
  const span = domain[1] - domain[0];
  const d = new Date(v);
  if (span <= 24 * 60 * 60 * 1000) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "2-digit" }) + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function fmtTimeShort(v: number) {
  return new Date(v).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function fmtTimeFull(v: number) {
  return new Date(v).toLocaleString([], {
    month: "short", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function fmtKbps(v: number) {
  if (v >= 1024) return `${(v / 1024).toFixed(2)} MB/s`;
  return `${v.toFixed(1)} kB/s`;
}

function labelFor(min: number) {
  if (min < 60) return `${min}m`;
  if (min < 1440) return `${min / 60}h`;
  return `${min / 1440}d`;
}


function Terminal({
  serverName,
  online,
  commands,
  onSubmit,
  running,
}: {
  serverName: string;
  online: boolean;
  commands: CommandRow[];
  onSubmit: (cmd: string) => void;
  running: boolean;
}) {
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [hIdx, setHIdx] = useState<number>(-1);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Oldest → newest, filter cleared
  const visible = useMemo(
    () => [...commands].reverse().filter((c) => !hidden.has(c.id)),
    [commands, hidden],
  );

  // Only autoscroll when a new command id appears or output of the latest one grows.
  const lastSigRef = useRef<string>("");
  useEffect(() => {
    const sig = visible
      .map((c) => `${c.id}:${c.status}:${(c.stdout?.length ?? 0) + (c.stderr?.length ?? 0)}`)
      .join("|");
    if (sig === lastSigRef.current) return;
    lastSigRef.current = sig;
    const el = scrollRef.current;
    if (!el) return;
    // Stick to bottom only if user is already near it.
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [visible]);

  const focusInput = () => inputRef.current?.focus();

  const handleSubmit = () => {
    const cmd = input.trim();
    if (!cmd) return;
    if (cmd === "clear" || cmd === "cls") {
      setHidden(new Set(commands.map((c) => c.id)));
      setHistory((h) => [cmd, ...h]);
      setInput("");
      setHIdx(-1);
      return;
    }
    onSubmit(cmd);
    setHistory((h) => [cmd, ...h]);
    setInput("");
    setHIdx(-1);
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSubmit();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const next = Math.min(hIdx + 1, history.length - 1);
      if (next >= 0 && history[next] != null) {
        setHIdx(next);
        setInput(history[next]);
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = hIdx - 1;
      if (next < 0) {
        setHIdx(-1);
        setInput("");
      } else {
        setHIdx(next);
        setInput(history[next]);
      }
    } else if (e.key === "l" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      setHidden(new Set(commands.map((c) => c.id)));
    }
  };

  const prompt = `root@${serverName}:~#`;

  return (
    <Card className="overflow-hidden border-border/60 bg-terminal" onClick={focusInput}>
      <div className="flex items-center justify-between border-b border-border/40 px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        <div className="flex items-center gap-2">
          <TermIcon className="h-3.5 w-3.5" />
          <span>{serverName} · interactive shell</span>
          <span className={`status-dot ${online ? "bg-primary text-primary" : "bg-destructive text-destructive"}`} />
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              onClick={(e) => { e.stopPropagation(); onSubmit(p.cmd); }}
              disabled={running}
              className="rounded px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div
        ref={scrollRef}
        className="h-[60vh] min-h-[420px] overflow-auto p-4 font-mono text-[12.5px] leading-relaxed text-terminal-foreground"
      >
        {!online && (
          <div className="mb-3 text-warning">
            ⚠ Server is offline — commands will queue and run when the agent reconnects.
          </div>
        )}
        {visible.length === 0 && (
          <div className="text-muted-foreground">
            Welcome to Fleet shell. Type a command and press Enter. Use ↑/↓ for history, `clear` to wipe.
          </div>
        )}
        {visible.map((c) => {
          const dur = cmdDuration(c);
          const ok = c.status === "completed" && (c.exit_code ?? 0) === 0;
          return (
            <div key={c.id} className="mb-3">
              <div className="flex items-baseline gap-2">
                <span className="text-primary">{prompt}</span>
                <span className="whitespace-pre-wrap break-all">{c.command}</span>
              </div>
              {c.status === "pending" && (
                <div className="mt-0.5 text-muted-foreground">[queued — waiting for agent…]</div>
              )}
              {c.status === "running" && (
                <div className="mt-0.5 text-warning">[running… {dur}]</div>
              )}
              {c.stdout && (
                <pre className="mt-0.5 whitespace-pre-wrap break-words text-terminal-foreground">{c.stdout.replace(/\n+$/, "")}</pre>
              )}
              {c.stderr && (
                <pre className="mt-0.5 whitespace-pre-wrap break-words text-destructive">{c.stderr.replace(/\n+$/, "")}</pre>
              )}
              {(c.status === "completed" || c.status === "failed") && (
                <div className={`mt-0.5 text-[11px] ${ok ? "text-muted-foreground" : "text-destructive"}`}>
                  [exit {c.exit_code ?? "?"} · {dur}]
                </div>
              )}
            </div>
          );
        })}

        <div className="flex items-baseline gap-2">
          <span className="text-primary">{prompt}</span>
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            className="flex-1 border-0 bg-transparent p-0 font-mono text-[12.5px] text-terminal-foreground outline-none placeholder:text-muted-foreground/60"
            placeholder={running ? "queuing…" : "type a command"}
            autoFocus
          />
        </div>
      </div>
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
