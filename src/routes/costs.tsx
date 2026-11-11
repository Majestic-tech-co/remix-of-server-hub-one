import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { RequireAuth } from "@/components/RequireAuth";
import { AppShell } from "@/components/AppShell";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DollarSign, TrendingDown, AlertTriangle, Sparkles, Cloud } from "lucide-react";
import { toast } from "sonner";
import { friendlyError } from "@/lib/errors";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, LineChart, Line, CartesianGrid,
} from "recharts";

export const Route = createFileRoute("/costs")({
  component: () => (
    <RequireAuth>
      <AppShell>
        <Costs />
      </AppShell>
    </RequireAuth>
  ),
});

interface Cost { server_id: string; day: string; daily_cost: number; }
interface AwsServer { id: string; name: string; instance_id: string | null; region: string | null; }

// Realistic-ish daily rates by instance type (USD)
const RATE: Record<string, number> = {
  "t3.nano": 0.125, "t3.micro": 0.25, "t3.small": 0.5, "t3.medium": 1.0, "t3.large": 2.0,
  "t3.xlarge": 4.0, "m5.large": 2.3, "m5.xlarge": 4.6, "m5.2xlarge": 9.2,
  "c5.large": 2.04, "c5.xlarge": 4.08, "r5.large": 3.02, "r5.xlarge": 6.05,
};
const defaultRate = (instance: string | null) => {
  if (!instance) return 1.2;
  return RATE[instance] ?? 1.5;
};

function Costs() {
  const { user } = useAuth();
  const [aws, setAws] = useState<AwsServer[]>([]);
  const [costs, setCosts] = useState<Cost[]>([]);
  const [cpu24h, setCpu24h] = useState<Record<string, number>>({});

  const load = async () => {
    const { data: srv } = await supabase.from("servers")
      .select("id,name,instance_id,region,type").eq("type", "aws");
    const awsRows = (srv ?? []) as AwsServer[];
    setAws(awsRows);

    const since = new Date(); since.setUTCDate(since.getUTCDate() - 30);
    const { data: cs } = await supabase.from("cost_metrics")
      .select("server_id,day,daily_cost")
      .gte("day", since.toISOString().slice(0, 10))
      .order("day");
    setCosts(((cs ?? []) as any).map((r: any) => ({ ...r, daily_cost: Number(r.daily_cost) })));

    if (awsRows.length) {
      const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const { data: m } = await supabase.from("metrics")
        .select("server_id,cpu_percent,recorded_at")
        .in("server_id", awsRows.map((s) => s.id))
        .gte("recorded_at", yesterday);
      const acc: Record<string, { sum: number; n: number }> = {};
      for (const r of (m ?? []) as any[]) {
        if (r.cpu_percent == null) continue;
        const a = acc[r.server_id] ?? { sum: 0, n: 0 };
        a.sum += Number(r.cpu_percent); a.n += 1;
        acc[r.server_id] = a;
      }
      const out: Record<string, number> = {};
      for (const id of Object.keys(acc)) out[id] = acc[id].sum / acc[id].n;
      setCpu24h(out);
    }
  };

  useEffect(() => { if (user) load(); }, [user]);

  const seedDemo = async () => {
    if (!user || !aws.length) return;
    const rows: any[] = [];
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    for (const s of aws) {
      const base = defaultRate(s.instance_id);
      for (let d = 29; d >= 0; d--) {
        const day = new Date(today); day.setUTCDate(day.getUTCDate() - d);
        const noise = 0.85 + Math.random() * 0.3;
        // throw in a spike on day 1 for anomaly demo
        const spike = d === 1 ? 1.8 : 1;
        rows.push({
          user_id: user.id, server_id: s.id, day: day.toISOString().slice(0, 10),
          daily_cost: Number((base * noise * spike).toFixed(4)), currency: "USD",
        });
      }
    }
    const { error } = await supabase.from("cost_metrics").upsert(rows, { onConflict: "server_id,day" });
    if (error) toast.error(friendlyError(error));
    else { toast.success(`Seeded ${rows.length} demo cost rows`); load(); }
  };

  const mtd = useMemo(() => {
    const first = new Date(); first.setUTCDate(1); first.setUTCHours(0, 0, 0, 0);
    const cut = first.toISOString().slice(0, 10);
    const byServer: Record<string, number> = {};
    let total = 0;
    for (const c of costs) {
      if (c.day < cut) continue;
      byServer[c.server_id] = (byServer[c.server_id] ?? 0) + c.daily_cost;
      total += c.daily_cost;
    }
    return { byServer, total };
  }, [costs]);

  const dailyTrend = useMemo(() => {
    const byDay: Record<string, number> = {};
    for (const c of costs) byDay[c.day] = (byDay[c.day] ?? 0) + c.daily_cost;
    return Object.entries(byDay).map(([day, cost]) => ({ day: day.slice(5), cost: Number(cost.toFixed(2)) }));
  }, [costs]);

  const barData = aws.map((s) => ({
    name: s.name,
    mtd: Number((mtd.byServer[s.id] ?? 0).toFixed(2)),
  }));

  const anomalies = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    const out: { server: AwsServer; today: number; avg7: number }[] = [];
    for (const s of aws) {
      const rows = costs.filter((c) => c.server_id === s.id);
      const todayRow = rows.find((r) => r.day === today);
      const last7 = rows.filter((r) => r.day < today).slice(-7);
      if (!todayRow || last7.length < 3) continue;
      const avg = last7.reduce((a, r) => a + r.daily_cost, 0) / last7.length;
      if (todayRow.daily_cost > avg * 1.5) out.push({ server: s, today: todayRow.daily_cost, avg7: avg });
    }
    return out;
  }, [aws, costs]);

  const underutilized = useMemo(() => {
    return aws.filter((s) => cpu24h[s.id] != null && cpu24h[s.id] < 10);
  }, [aws, cpu24h]);

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-mono text-xs uppercase tracking-widest text-muted-foreground">// costs</h1>
          <h2 className="mt-1 text-3xl font-semibold tracking-tight">Cloud cost tracker</h2>
          <p className="mt-1 text-sm text-muted-foreground">Demo estimates. Hook up real AWS Cost Explorer when you're ready.</p>
        </div>
        {aws.length > 0 && (
          <Button variant="outline" onClick={seedDemo}>
            <Sparkles className="h-4 w-4" /> Seed demo costs (30d)
          </Button>
        )}
      </div>

      {aws.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 p-12 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <Cloud className="h-5 w-5 text-primary" />
          </div>
          <div className="font-medium">No AWS servers</div>
          <div className="max-w-sm text-sm text-muted-foreground">
            Mark a server as type "aws" with an instance type to see cost estimates here.
          </div>
          <Link to="/" className="text-sm text-primary hover:underline">Go to servers →</Link>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <Card className="p-5">
              <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                <DollarSign className="h-3.5 w-3.5" /> MTD spend
              </div>
              <div className="mt-1 font-mono text-3xl font-semibold">${mtd.total.toFixed(2)}</div>
            </Card>
            <Card className="p-5">
              <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                <AlertTriangle className="h-3.5 w-3.5" /> Anomalies today
              </div>
              <div className={`mt-1 font-mono text-3xl font-semibold ${anomalies.length ? "text-destructive" : ""}`}>
                {anomalies.length}
              </div>
            </Card>
            <Card className="p-5">
              <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                <TrendingDown className="h-3.5 w-3.5" /> Underutilized
              </div>
              <div className={`mt-1 font-mono text-3xl font-semibold ${underutilized.length ? "text-warning" : ""}`}>
                {underutilized.length}
              </div>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="p-5">
              <div className="mb-4 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">// MTD by instance</div>
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={barData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="name" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                  <YAxis tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                  <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", fontFamily: "monospace", fontSize: 12 }} />
                  <Bar dataKey="mtd" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </Card>

            <Card className="p-5">
              <div className="mb-4 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">// daily total (30d)</div>
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={dailyTrend}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="day" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                  <YAxis tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                  <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", fontFamily: "monospace", fontSize: 12 }} />
                  <Line type="monotone" dataKey="cost" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="p-5">
              <div className="mb-3 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                <AlertTriangle className="h-3.5 w-3.5" /> Cost anomalies
              </div>
              {anomalies.length === 0 ? (
                <div className="text-sm text-muted-foreground">No spikes detected.</div>
              ) : (
                <ul className="space-y-2">
                  {anomalies.map((a) => (
                    <li key={a.server.id} className="flex items-center justify-between rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
                      <span className="font-medium">{a.server.name}</span>
                      <span className="font-mono text-xs text-destructive">
                        ${a.today.toFixed(2)} vs ${a.avg7.toFixed(2)} avg
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card className="p-5">
              <div className="mb-3 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                <TrendingDown className="h-3.5 w-3.5" /> Underutilized (real CPU 24h)
              </div>
              {underutilized.length === 0 ? (
                <div className="text-sm text-muted-foreground">Nothing flagged. Need 24h of metrics first.</div>
              ) : (
                <ul className="space-y-2">
                  {underutilized.map((s) => (
                    <li key={s.id} className="flex items-center justify-between rounded-md border border-warning/30 bg-warning/5 px-3 py-2">
                      <Link to="/servers/$id" params={{ id: s.id }} className="font-medium hover:underline">{s.name}</Link>
                      <span className="font-mono text-xs text-warning">avg CPU {cpu24h[s.id].toFixed(1)}%</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
