import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/reset-password")({
  head: () => ({ meta: [{ title: "Reset password — Fleet" }, { name: "robots", content: "noindex" }] }),
  component: ResetPasswordPage,
});

// The emailed recovery link signs the user in with a short-lived session; we then
// let them choose a new password. If the link was already used/expired there is no
// session, so we show a clear message instead of a broken form.
function ResetPasswordPage() {
  const { user, loading, updatePassword } = useAuth();
  const navigate = useNavigate();
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [waited, setWaited] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setWaited(true), 2500);
    return () => clearTimeout(t);
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pw.length < 10 || pw.length > 128) return toast.error("Use 10–128 characters.");
    if (pw !== pw2) return toast.error("Passwords don't match.");
    setBusy(true);
    const { error } = await updatePassword(pw);
    setBusy(false);
    if (error) return toast.error(error);
    toast.success("Password updated.");
    navigate({ to: "/" });
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-semibold tracking-tight">Choose a new password</h1>
        {!user && (loading || !waited) ? (
          <p className="mt-4 text-sm text-muted-foreground">Verifying your link…</p>
        ) : !user ? (
          <div className="mt-4 space-y-4">
            <p className="text-sm text-muted-foreground">
              This reset link is invalid, expired, or was already used.
            </p>
            <Button onClick={() => navigate({ to: "/auth" })} className="w-full">Request a new link</Button>
          </div>
        ) : (
          <form onSubmit={submit} className="mt-6 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="pw">New password</Label>
              <Input id="pw" type="password" autoComplete="new-password" minLength={10} maxLength={128} required value={pw} onChange={(e) => setPw(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="pw2">Confirm password</Label>
              <Input id="pw2" type="password" autoComplete="new-password" minLength={10} maxLength={128} required value={pw2} onChange={(e) => setPw2(e.target.value)} />
            </div>
            <Button type="submit" className="w-full" disabled={busy}>{busy ? "..." : "Update password"}</Button>
          </form>
        )}
      </div>
    </div>
  );
}
