import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, ScrollText, WifiOff } from "lucide-react";
import { RequireAuth } from "@/components/RequireAuth";
import { AppShell } from "@/components/AppShell";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { fullTime, timeAgo } from "@/lib/format";
import { Card } from "@/components/ui/card";

export const Route = createFileRoute("/activity")({
  head: () => ({ meta: [{ title: "Activity — Fleet" }] }),
  component: () => (
    <RequireAuth>
      <AppShell>
        <Activity />
      </AppShell>
    </RequireAuth>
  ),
});

type AlertRow = { id: string; server_id: string; kind: string; message: string; created_at: string; resolved_at: string | null };
type AuditRow = { id: number; action: string; target_type: string | null; target_id: string | null; detail: Record<string, unknown>; created_at: string };

const ACTIONS: Record<string, string> = {
  "command.queued": "Command queued",
  "server.created": "Server added",
  "server.deleted": "Server deleted",
  "server.token_rotated": "Agent token rotated",
  "terminal.started": "Terminal session opened",
  "account.exported": "Data exported",
};

function describe(a: AuditRow): string {
  const d = a.detail ?? {};
  if (a.action === "command.queued") return String(d.command ?? "");
  if (typeof d.name === "string") return d.name;
  return "";
}

function Activity() {
  const { user } = useAuth();
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [events, setEvents] = useState<AuditRow[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!user) return;
    (async () => {
      const [a, e, s] = await Promise.all([
        supabase.from("alerts").select("id,server_id,kind,message,created_at,resolved_at").order("created_at", { ascending: false }).limit(50),
        supabase.from("audit_log").select("id,action,target_type,target_id,detail,created_at").order("created_at", { ascending: false }).limit(200),
        supabase.from("servers").select("id,name"),
      ]);
      setAlerts((a.data as AlertRow[]) ?? []);
      setEvents((e.data as AuditRow[]) ?? []);
      setNames(Object.fromEntries(((s.data as { id: string; name: string }[]) ?? []).map((x) => [x.id, x.name])));
      setLoaded(true);
    })();
  }, [user]);

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <div>
        <h1 className="font-mono text-xs uppercase tracking-widest text-muted-foreground">// activity</h1>
        <h2 className="mt-1 text-3xl font-semibold tracking-tight">Alerts &amp; audit log</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Servers that stopped reporting or ran hot, and a record of every command and change on your account.
        </p>
      </div>

      <Card className="p-5">
        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          <AlertTriangle className="h-3.5 w-3.5" /> Alerts
        </div>
        {!loaded ? (
          <p className="mt-4 text-sm text-muted-foreground">Loading…</p>
        ) : alerts.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">No alerts yet. You'll see one if a server goes quiet for 5 minutes or CPU, memory or disk reaches 90%.</p>
        ) : (
          <ul className="mt-4 divide-y divide-border/50">
            {alerts.map((a) => (
              <li key={a.id} className="flex items-center gap-3 py-2.5 text-sm">
                {a.resolved_at ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
                ) : a.kind === "offline" ? (
                  <WifiOff className="h-4 w-4 shrink-0 text-destructive" />
                ) : (
                  <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
                )}
                <Link to="/servers/$id" params={{ id: a.server_id }} className="min-w-0 flex-1 truncate hover:underline">
                  {a.message}
                </Link>
                <span className="shrink-0 font-mono text-xs text-muted-foreground" title={fullTime(a.created_at)}>
                  {a.resolved_at ? `resolved ${timeAgo(a.resolved_at)}` : timeAgo(a.created_at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="p-5">
        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          <ScrollText className="h-3.5 w-3.5" /> Audit log
        </div>
        {!loaded ? (
          <p className="mt-4 text-sm text-muted-foreground">Loading…</p>
        ) : events.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">Nothing recorded yet.</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                <tr>
                  <th className="pb-2 pr-4 font-normal">When</th>
                  <th className="pb-2 pr-4 font-normal">Event</th>
                  <th className="pb-2 pr-4 font-normal">Server</th>
                  <th className="pb-2 font-normal">Detail</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {events.map((e) => (
                  <tr key={e.id}>
                    <td className="whitespace-nowrap py-2 pr-4 font-mono text-xs text-muted-foreground" title={fullTime(e.created_at)}>
                      {timeAgo(e.created_at)}
                    </td>
                    <td className="whitespace-nowrap py-2 pr-4">{ACTIONS[e.action] ?? e.action}</td>
                    <td className="whitespace-nowrap py-2 pr-4 text-muted-foreground">
                      {e.target_id && names[e.target_id] ? (
                        <Link to="/servers/$id" params={{ id: e.target_id }} className="hover:underline">{names[e.target_id]}</Link>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="max-w-xs truncate py-2 font-mono text-xs text-muted-foreground" title={describe(e)}>
                      {describe(e)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
