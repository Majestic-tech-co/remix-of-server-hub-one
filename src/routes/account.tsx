import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { Download, Trash2, ShieldAlert } from "lucide-react";
import { RequireAuth } from "@/components/RequireAuth";
import { AppShell } from "@/components/AppShell";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";
import { authedPost } from "@/lib/servers";
import { Card } from "@/components/ui/card";
import { TwoFactorCard } from "@/components/TwoFactorCard";
import { DesktopAppCard } from "@/components/DesktopAppCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/account")({
  head: () => ({ meta: [{ title: "Account — Fleet" }] }),
  component: () => (
    <RequireAuth>
      <AppShell>
        <Account />
      </AppShell>
    </RequireAuth>
  ),
});

function Account() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const [exporting, setExporting] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [deleting, setDeleting] = useState(false);

  const exportData = async () => {
    setExporting(true);
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) return toast.error("Your session has expired. Please sign in again.");
      const res = await fetch("/api/account/export", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        return toast.error(typeof j?.error === "string" ? j.error : "Export failed. Please try again.");
      }
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = "fleet-data-export.json";
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Your data export has been downloaded.");
    } catch {
      toast.error("Network problem. Check your connection and try again.");
    } finally {
      setExporting(false);
    }
  };

  const deleteAccount = async () => {
    if (!window.confirm("This permanently deletes your account, all servers and all data. This cannot be undone. Continue?")) return;
    setDeleting(true);
    const { error } = await authedPost("/api/account/delete", { confirm_email: confirm });
    setDeleting(false);
    if (error) return toast.error(error);
    toast.success("Your account has been deleted.");
    await signOut().catch(() => {});
    navigate({ to: "/auth" });
  };

  const emailMatches = !!user?.email && confirm.trim().toLowerCase() === user.email.toLowerCase();

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <div>
        <h1 className="font-mono text-xs uppercase tracking-widest text-muted-foreground">// account</h1>
        <h2 className="mt-1 text-3xl font-semibold tracking-tight">Your account</h2>
        <p className="mt-1 text-sm text-muted-foreground">{user?.email}</p>
      </div>

      <TwoFactorCard />

      <DesktopAppCard />

      <Card className="p-6">
        <div className="flex items-start gap-3">
          <Download className="mt-0.5 h-5 w-5 text-primary" />
          <div className="flex-1">
            <h3 className="font-semibold">Export your data</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Download everything we hold about you as a JSON file: servers, commands and their output, playbooks, runs and
              metrics. Agent tokens and terminal contents are not included.
            </p>
            <Button className="mt-4" onClick={exportData} disabled={exporting}>
              {exporting ? "Preparing…" : "Download my data"}
            </Button>
          </div>
        </div>
      </Card>

      <Card className="border-destructive/40 p-6">
        <div className="flex items-start gap-3">
          <ShieldAlert className="mt-0.5 h-5 w-5 text-destructive" />
          <div className="flex-1">
            <h3 className="font-semibold text-destructive">Delete account</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Permanently removes your account and everything in it. Agents already installed on your servers stop
              reporting; run the uninstall command from each server's page first if you want them removed cleanly.
            </p>
            <div className="mt-4 space-y-2">
              <Label htmlFor="confirm-email">Type your email to confirm</Label>
              <Input
                id="confirm-email"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder={user?.email ?? ""}
                autoComplete="off"
                maxLength={254}
              />
            </div>
            <Button variant="destructive" className="mt-4" onClick={deleteAccount} disabled={!emailMatches || deleting}>
              <Trash2 className="h-4 w-4" /> {deleting ? "Deleting…" : "Delete my account"}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
