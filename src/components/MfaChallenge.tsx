import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ShieldCheck } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Shown after the password step for accounts that have two-factor set up. */
export function MfaChallenge() {
  const { user, signOut, refreshMfa } = useAuth();
  const [factorId, setFactorId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supabase.auth.mfa.listFactors().then(({ data }) => {
      setFactorId(data?.totp?.[0]?.id ?? null); // `totp` holds verified authenticator factors
    });
  }, []);

  const verify = async (value: string) => {
    if (!factorId || busy) return;
    setBusy(true);
    try {
      const { data: ch, error: cErr } = await supabase.auth.mfa.challenge({ factorId });
      if (cErr || !ch) throw cErr ?? new Error("challenge failed");
      const { error } = await supabase.auth.mfa.verify({ factorId, challengeId: ch.id, code: value });
      if (error) throw error;
      await refreshMfa(); // session is now aal2; the app unlocks
    } catch {
      toast.error("That code didn't work. Check your authenticator app and try again.");
      setCode("");
    } finally {
      setBusy(false);
    }
  };

  const onChange = (v: string) => {
    const digits = v.replace(/\D/g, "").slice(0, 6);
    setCode(digits);
    if (digits.length === 6) verify(digits);
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="glass gradient-border w-full max-w-sm rounded-2xl p-8">
        <div className="btn-glow mx-auto flex h-12 w-12 items-center justify-center rounded-xl">
          <ShieldCheck className="h-6 w-6 text-primary-foreground" />
        </div>
        <h1 className="mt-5 text-center font-display text-2xl font-bold tracking-tight">Two-factor check</h1>
        <p className="mt-1 text-center text-sm text-muted-foreground">
          Enter the 6-digit code from your authenticator app for {user?.email}.
        </p>
        <form
          className="mt-6 space-y-4"
          onSubmit={(e) => { e.preventDefault(); if (code.length === 6) verify(code); }}
        >
          <div className="space-y-2">
            <Label htmlFor="mfa-code">Code</Label>
            <Input
              id="mfa-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              maxLength={6}
              value={code}
              onChange={(e) => onChange(e.target.value)}
              placeholder="123456"
              className="text-center font-mono text-xl tracking-[0.4em]"
              disabled={busy || !factorId}
            />
          </div>
          <Button type="submit" className="w-full" disabled={busy || code.length !== 6 || !factorId}>
            {busy ? "Checking…" : "Verify"}
          </Button>
        </form>
        <button
          onClick={() => signOut()}
          className="mt-5 block w-full text-center text-xs text-muted-foreground hover:text-foreground hover:underline"
        >
          Sign out
        </button>
        <p className="mt-4 text-center text-[11px] text-muted-foreground">
          Lost your authenticator? A team owner can reset your two-factor from the Team page.
        </p>
      </div>
    </div>
  );
}
