import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Bell, AlertTriangle, WifiOff } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { friendlyError } from "@/lib/errors";
import { timeAgo } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { toast } from "sonner";

type AlertRow = {
  id: string;
  server_id: string;
  kind: string;
  message: string;
  acknowledged: boolean;
  created_at: string;
};

export function AlertsBell() {
  const { user } = useAuth();
  const [alerts, setAlerts] = useState<AlertRow[]>([]);

  const load = useCallback(async () => {
    if (!user) return;
    const { data } = await supabase
      .from("alerts")
      .select("id,server_id,kind,message,acknowledged,created_at")
      .is("resolved_at", null)
      .order("created_at", { ascending: false })
      .limit(20);
    setAlerts((data as AlertRow[]) ?? []);
  }, [user]);

  useEffect(() => {
    load();
    const i = setInterval(load, 30_000);
    return () => clearInterval(i);
  }, [load]);

  const unread = alerts.filter((a) => !a.acknowledged);

  const ackAll = async () => {
    const ids = unread.map((a) => a.id);
    if (ids.length === 0) return;
    const { error } = await supabase.from("alerts").update({ acknowledged: true }).in("id", ids);
    if (error) return toast.error(friendlyError(error));
    load();
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="relative" aria-label="Alerts">
          <Bell className="h-4 w-4" />
          {unread.length > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 font-mono text-[9px] font-bold text-destructive-foreground">
              {unread.length > 9 ? "9+" : unread.length}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
          <span className="text-sm font-semibold">Alerts</span>
          {unread.length > 0 && (
            <button onClick={ackAll} className="text-xs text-primary hover:underline">
              Acknowledge all
            </button>
          )}
        </div>
        {alerts.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">All clear. Nothing needs attention.</p>
        ) : (
          <ul className="max-h-72 divide-y divide-border/50 overflow-auto">
            {alerts.map((a) => (
              <li key={a.id} className="flex gap-3 px-4 py-3">
                {a.kind === "offline" ? (
                  <WifiOff className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                ) : (
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                )}
                <div className="min-w-0">
                  <Link to="/servers/$id" params={{ id: a.server_id }} className="block truncate text-sm hover:underline">
                    {a.message}
                  </Link>
                  <span className="font-mono text-[11px] text-muted-foreground">{timeAgo(a.created_at)}</span>
                </div>
                {!a.acknowledged && <span className="status-dot ml-auto mt-1.5 shrink-0 bg-destructive text-destructive" />}
              </li>
            ))}
          </ul>
        )}
        <div className="border-t border-border/60 px-4 py-2 text-right">
          <Link to="/activity" className="text-xs text-muted-foreground hover:text-foreground hover:underline">
            View all activity →
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}
