import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ShieldCheck, ShieldOff } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useWorkspace } from "@/lib/workspace";
import { friendlyError } from "@/lib/errors";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Enrolling = { id: string; qr: string; secret: string };

/** Set up or remove an authenticator app (TOTP) for the signed-in account. */
export function TwoFactorCard() {
  const { mfa, refreshMfa } = useAuth();
  const { workspaces } = useWorkspace();
  const [verifiedId, setVerifiedId] = useState<string | null>(null);
  const [enrolling, setEnrolling] = useState<Enrolling | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const { data } = await supabase.auth.mfa.listFactors();
    setVerifiedId(data?.totp?.[0]?.id ?? null);
    setLoaded(true);
  }, []);
  useEffect(() => { load(); }, [load]);

  const requiredBy = workspaces.filter((w) => w.require_mfa).map((w) => w.name);

  const start = async () => {
    setBusy(true);
    try {
      // Clear any half-finished earlier attempt so the list stays clean.
      const { data: all } = await supabase.auth.mfa.listFactors();
      for (const f of all?.all ?? []) {
        if (f.status === "unverified") await supabase.auth.mfa.unenroll({ factorId: f.id });
      }
      const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp", friendlyName: `Fleet ${new Date().toISOString().slice(0, 10)}` });
      if (error || !data) throw error ?? new Error("enroll failed");
      setEnrolling({ id: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
      setCode("");
    } catch (e) {
      toast.error(friendlyError(e, "Couldn't start setup. Please try again."));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!enrolling) return;
    setBusy(true);
    try {
      const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: enrolling.id, code: code.trim() });
      if (error) throw error;
      toast.success("Two-factor is on. You'll be asked for a code each time you sign in.");
      setEnrolling(null);
      setCode("");
      await refreshMfa();
      await load();
    } catch {
      toast.error("That code didn't match. Wait for the next code in your app and try again.");
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (enrolling) await supabase.auth.mfa.unenroll({ factorId: enrolling.id });
    setEnrolling(null);
  };

  const disable = async () => {
    if (!verifiedId) return;
    const warn = requiredBy.length
      ? ` Your team${requiredBy.length > 1 ? "s" : ""} (${requiredBy.join(", ")}) require${requiredBy.length > 1 ? "" : "s"} two-factor, so you'll lose access to ${requiredBy.length > 1 ? "them" : "it"} until you set it up again.`
      : "";
    if (!window.confirm("Turn off two-factor sign-in? Your account will be protected by your password alone." + warn)) return;
    setBusy(true);
    const { error } = await supabase.auth.mfa.unenroll({ factorId: verifiedId });
    setBusy(false);
    if (error) return toast.error(friendlyError(error));
    toast.success("Two-factor turned off.");
    await refreshMfa();
    await load();
  };

  return (
    <Card className="p-6">
      <div className="flex items-start gap-3">
        {mfa.enrolled ? (
          <ShieldCheck className="mt-0.5 h-5 w-5 text-success" />
        ) : (
          <ShieldOff className="mt-0.5 h-5 w-5 text-warning" />
        )}
        <div className="flex-1">
          <h3 className="font-semibold">Two-factor sign-in</h3>
          {!loaded ? (
            <p className="mt-1 text-sm text-muted-foreground">Loading…</p>
          ) : enrolling ? (
            <form onSubmit={confirm} className="mt-2 space-y-4">
              <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
                <li>Open an authenticator app (Google Authenticator, 1Password, Authy…).</li>
                <li>Scan this QR code, or enter the key by hand.</li>
                <li>Type the 6-digit code the app shows.</li>
              </ol>
              <div className="flex flex-wrap items-center gap-4">
                <img src={enrolling.qr} alt="QR code to add this account to your authenticator app" className="h-40 w-40 rounded-lg bg-white p-2" />
                <div className="min-w-0 text-xs text-muted-foreground">
                  <div>Can't scan? Enter this key:</div>
                  <code className="mt-1 block break-all rounded bg-muted px-2 py-1 font-mono text-foreground">{enrolling.secret}</code>
                </div>
              </div>
              <div className="max-w-xs space-y-2">
                <Label htmlFor="enroll-code">6-digit code</Label>
                <Input
                  id="enroll-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  className="font-mono tracking-[0.3em]"
                  placeholder="123456"
                />
              </div>
              <div className="flex gap-2">
                <Button type="submit" disabled={busy || code.length !== 6}>Turn on</Button>
                <Button type="button" variant="ghost" onClick={cancel} disabled={busy}>Cancel</Button>
              </div>
            </form>
          ) : mfa.enrolled ? (
            <>
              <p className="mt-1 text-sm text-muted-foreground">
                On. You enter a code from your authenticator app each time you sign in, and nothing in the app or its API
                works with a password alone.
              </p>
              <Button variant="outline" className="mt-4" onClick={disable} disabled={busy}>Turn off</Button>
            </>
          ) : (
            <>
              <p className="mt-1 text-sm text-muted-foreground">
                Off. This account can run commands as root on your servers, so protect it with a second step. You'll scan a
                QR code with an authenticator app once, then enter a 6-digit code at each sign-in.
              </p>
              {requiredBy.length > 0 && (
                <p className="mt-2 rounded-md border border-warning/40 bg-warning/10 p-2 text-sm">
                  {requiredBy.join(", ")} require{requiredBy.length > 1 ? "" : "s"} two-factor. You can't use {requiredBy.length > 1 ? "those teams" : "that team"} until you turn it on.
                </p>
              )}
              <Button className="mt-4" onClick={start} disabled={busy}>Set up two-factor</Button>
            </>
          )}
        </div>
      </div>
    </Card>
  );
}
