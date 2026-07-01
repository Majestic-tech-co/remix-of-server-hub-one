import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { RequireAuth } from "@/components/RequireAuth";
import { AppShell } from "@/components/AppShell";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Plus, Cpu, MemoryStick, HardDrive, Copy, Server as ServerIcon, MoreVertical, Trash2, Activity, ArrowDown, ArrowUp } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export const Route = createFileRoute("/")({
  component: () => (
    <RequireAuth>
      <AppShell>
        <Dashboard />
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
  type: string;
  region: string | null;
  instance_id: string | null;
  tags: string[];
  agent_token: string;
  last_seen_at: string | null;
  created_at: string;
}

interface MetricRow {
  server_id: string;
  cpu_percent: number | null;
  memory_percent: number | null;
  disk_percent: number | null;
  disk_used_gb: number | null;
  disk_total_gb: number | null;
  load_1: number | null;
  net_rx_kbs: number | null;
  net_tx_kbs: number | null;
  recorded_at: string;
}

function Dashboard() {
  const { user } = useAuth();
  const [servers, setServers] = useState<ServerRow[]>([]);
  const [latestMetrics, setLatestMetrics] = useState<Record<string, MetricRow>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;

    const load = async () => {
      const { data: srv } = await supabase
        .from("servers")
        .select("*")
        .order("created_at", { ascending: false });
      setServers((srv ?? []) as ServerRow[]);

      if (srv && srv.length > 0) {
        // Fetch latest metric per server
        const ids = srv.map((s) => s.id);
        const { data: m } = await supabase
          .from("metrics")
          .select("server_id, cpu_percent, memory_percent, disk_percent, disk_used_gb, disk_total_gb, load_1, net_rx_kbs, net_tx_kbs, recorded_at")
          .in("server_id", ids)
          .order("recorded_at", { ascending: false })
          .limit(500);

        const map: Record<string, MetricRow> = {};
        for (const row of (m ?? []) as MetricRow[]) {
          if (!map[row.server_id]) map[row.server_id] = row;
        }
        setLatestMetrics(map);
      }
      setLoading(false);
    };

    load();
    const interval = setInterval(load, 15000);
    return () => clearInterval(interval);
  }, [user]);

  const stats = useMemo(() => {
    const total = servers.length;
    const online = servers.filter((s) => isOnline(s.last_seen_at)).length;
    return { total, online, offline: total - online };
  }, [servers]);

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
            // dashboard
          </h1>
          <h2 className="mt-1 text-3xl font-semibold tracking-tight">Your fleet</h2>
        </div>
        <AddServerDialog onAdded={(s) => setServers((prev) => [s, ...prev])} />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Total servers" value={stats.total} />
        <StatCard label="Online" value={stats.online} accent="success" />
        <StatCard label="Offline" value={stats.offline} accent={stats.offline > 0 ? "destructive" : "muted"} />
      </div>

      {loading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : servers.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="space-y-8">
          {(["aws", "local"] as const).map((group) => {
            const list = servers.filter((s) => (s.type ?? "local") === group);
            if (list.length === 0) return null;
            return (
              <div key={group}>
                <div className="mb-3 flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                  <span>// {group === "aws" ? "AWS instances" : "Local / on-prem"}</span>
                  <span className="text-foreground/40">({list.length})</span>
                </div>
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {list.map((s) => (
                    <ServerCard
                      key={s.id}
                      server={s}
                      metric={latestMetrics[s.id]}
                      onDeleted={() => setServers((prev) => prev.filter((x) => x.id !== s.id))}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function isOnline(lastSeen: string | null) {
  if (!lastSeen) return false;
  return Date.now() - new Date(lastSeen).getTime() < 90_000; // 90s grace
}

function StatCard({ label, value, accent }: { label: string; value: number; accent?: "success" | "destructive" | "muted" }) {
  const color =
    accent === "success" ? "text-primary" :
    accent === "destructive" ? "text-destructive" :
    accent === "muted" ? "text-muted-foreground" : "text-foreground";
  return (
    <Card className="p-5">
      <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className={`mt-1 font-mono text-3xl font-semibold ${color}`}>{value}</div>
    </Card>
  );
}

function ServerCard({
  server,
  metric,
  onDeleted,
}: {
  server: ServerRow;
  metric?: MetricRow;
  onDeleted: () => void;
}) {
  const online = isOnline(server.last_seen_at);

  const onDelete = async () => {
    if (!confirm(`Remove ${server.name}? Metrics history will be deleted.`)) return;
    const { error } = await supabase.from("servers").delete().eq("id", server.id);
    if (error) toast.error(error.message);
    else {
      toast.success("Server removed");
      onDeleted();
    }
  };

  return (
    <Card className="group relative overflow-hidden p-5 transition-colors hover:border-primary/30">
      <div className="flex items-start justify-between gap-3">
        <Link to="/servers/$id" params={{ id: server.id }} className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className={`status-dot ${online ? "bg-primary text-primary" : "bg-destructive text-destructive"}`}
            />
            <h3 className="truncate font-medium">{server.name}</h3>
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[9px] uppercase text-muted-foreground">
              {server.type ?? "local"}
            </span>
          </div>
          <div className="mt-1 truncate font-mono text-xs text-muted-foreground">
            {server.hostname || server.ip_address || "no host yet"}
            {server.instance_id && <span className="ml-2 text-foreground/60">· {server.instance_id}</span>}
            {server.region && <span className="ml-2">· {server.region}</span>}
          </div>
        </Link>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-7 w-7">
              <MoreVertical className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onDelete} className="text-destructive focus:text-destructive">
              <Trash2 className="mr-2 h-4 w-4" /> Remove
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="mt-5 grid grid-cols-3 gap-3">
        <Metric icon={<Cpu className="h-3.5 w-3.5" />} label="CPU" value={metric?.cpu_percent} />
        <Metric icon={<MemoryStick className="h-3.5 w-3.5" />} label="MEM" value={metric?.memory_percent} />
        <Metric icon={<HardDrive className="h-3.5 w-3.5" />} label="DISK" value={metric?.disk_percent} />
      </div>

      <div className="mt-3 grid grid-cols-3 gap-3 border-t border-border/50 pt-3">
        <SubMetric
          icon={<Activity className="h-3.5 w-3.5" />}
          label="LOAD"
          value={metric?.load_1 == null ? "—" : Number(metric.load_1).toFixed(2)}
        />
        <SubMetric
          icon={<HardDrive className="h-3.5 w-3.5" />}
          label="USED"
          value={
            metric?.disk_used_gb == null
              ? "—"
              : `${Math.round(Number(metric.disk_used_gb))}/${Math.round(Number(metric.disk_total_gb ?? 0))}G`
          }
        />
        <SubMetric
          icon={
            <span className="flex items-center">
              <ArrowDown className="h-3 w-3" />
              <ArrowUp className="h-3 w-3" />
            </span>
          }
          label="NET"
          value={
            metric?.net_rx_kbs == null && metric?.net_tx_kbs == null
              ? "—"
              : `${formatKbs(metric?.net_rx_kbs)}↓ ${formatKbs(metric?.net_tx_kbs)}↑`
          }
        />
      </div>

      {server.tags.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-1.5">
          {server.tags.map((t) => (
            <span key={t} className="rounded bg-muted px-2 py-0.5 font-mono text-[10px] uppercase text-muted-foreground">
              {t}
            </span>
          ))}
        </div>
      )}
    </Card>
  );
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: number | null | undefined }) {
  const v = value == null ? null : Math.round(Number(value));
  const color =
    v == null ? "text-muted-foreground" :
    v >= 90 ? "text-destructive" :
    v >= 75 ? "text-warning" : "text-primary";
  return (
    <div>
      <div className="flex items-center gap-1 font-mono text-[10px] uppercase text-muted-foreground">
        {icon} {label}
      </div>
      <div className={`mt-1 font-mono text-lg font-semibold ${color}`}>
        {v == null ? "—" : `${v}%`}
      </div>
    </div>
  );
}

function SubMetric({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div>
      <div className="flex items-center gap-1 font-mono text-[10px] uppercase text-muted-foreground">
        {icon} {label}
      </div>
      <div className="mt-1 truncate font-mono text-xs font-medium text-foreground">{value}</div>
    </div>
  );
}

function formatKbs(v: number | null | undefined) {
  if (v == null) return "—";
  const n = Number(v);
  if (n >= 1024) return `${(n / 1024).toFixed(1)}M`;
  return `${Math.round(n)}K`;
}

function EmptyState() {
  return (
    <Card className="flex flex-col items-center justify-center gap-3 p-12 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
        <ServerIcon className="h-5 w-5 text-primary" />
      </div>
      <div>
        <div className="font-medium">No servers yet</div>
        <div className="mt-1 text-sm text-muted-foreground">
          Add your first server, then run the install command on it.
        </div>
      </div>
    </Card>
  );
}

function AddServerDialog({ onAdded }: { onAdded: (s: ServerRow) => void }) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [tags, setTags] = useState("");
  const [type, setType] = useState<"local" | "aws">("local");
  const [region, setRegion] = useState("");
  const [instanceId, setInstanceId] = useState("");
  const [created, setCreated] = useState<ServerRow | null>(null);

  const installCmd = useMemo(() => {
    if (!created) return "";
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    return `curl -fsSL ${origin}/api/agent/install | sudo FLEET_TOKEN=${created.agent_token} FLEET_URL=${origin} bash`;
  }, [created]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    const tagList = tags.split(",").map((t) => t.trim()).filter(Boolean);
    const { data, error } = await supabase
      .from("servers")
      .insert({
        user_id: user.id,
        name,
        tags: tagList,
        type,
        region: type === "aws" ? region || null : null,
        instance_id: type === "aws" ? instanceId || null : null,
      })
      .select()
      .single();
    if (error) {
      toast.error(error.message);
      return;
    }
    setCreated(data as ServerRow);
    onAdded(data as ServerRow);
  };

  const reset = () => {
    setName(""); setTags(""); setType("local"); setRegion(""); setInstanceId("");
    setCreated(null);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) reset(); }}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="h-4 w-4" /> Add server
        </Button>
      </DialogTrigger>
      <DialogContent>
        {!created ? (
          <form onSubmit={onSubmit}>
            <DialogHeader>
              <DialogTitle>Add a server</DialogTitle>
              <DialogDescription>
                Give it a name. We'll generate an install command next.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="name">Name</Label>
                <Input id="name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="prod-web-01" />
              </div>
              <div className="space-y-2">
                <Label>Type</Label>
                <div className="flex gap-2">
                  {(["local", "aws"] as const).map((t) => (
                    <button
                      type="button"
                      key={t}
                      onClick={() => setType(t)}
                      className={`flex-1 rounded-md border px-3 py-2 font-mono text-xs uppercase transition-colors ${
                        type === t ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-muted"
                      }`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>
              {type === "aws" && (
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-2">
                    <Label htmlFor="region">Region</Label>
                    <Input id="region" value={region} onChange={(e) => setRegion(e.target.value)} placeholder="us-east-1" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="instance">Instance type</Label>
                    <Input id="instance" value={instanceId} onChange={(e) => setInstanceId(e.target.value)} placeholder="t3.medium" />
                  </div>
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="tags">Tags (comma-separated)</Label>
                <Input id="tags" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="prod, web, eu" />
              </div>
            </div>
            <DialogFooter>
              <Button type="submit">Create</Button>
            </DialogFooter>
          </form>
        ) : (
          <div>
            <DialogHeader>
              <DialogTitle>Install the agent</DialogTitle>
              <DialogDescription>
                Run this on <span className="font-mono text-foreground">{created.name}</span> as root. It installs a tiny script that pings every 60s.
              </DialogDescription>
            </DialogHeader>
            <div className="my-4 rounded-md bg-terminal p-4">
              <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs text-terminal-foreground">
                {installCmd}
              </pre>
            </div>
            <DialogFooter className="gap-2">
              <Button
                variant="secondary"
                onClick={() => {
                  navigator.clipboard.writeText(installCmd);
                  toast.success("Copied");
                }}
              >
                <Copy className="h-4 w-4" /> Copy
              </Button>
              <Button onClick={() => setOpen(false)}>Done</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
