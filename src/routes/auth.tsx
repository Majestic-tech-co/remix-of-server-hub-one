import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Activity, Server, Terminal, Zap } from "lucide-react";
import { toast } from "sonner";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Turnstile, turnstileEnabled } from "@/components/Turnstile";
import { Constellation } from "@/components/Constellation";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Sign in — Fleet" },
      { name: "description", content: "Sign in to your server control center." },
    ],
  }),
  component: AuthPage,
});

type Mode = "signin" | "signup" | "forgot";

const MAX_FAILS = 5;
const COOLDOWN_MS = 60_000;
const PASSWORD_MIN = 10;

// Supabase redirects back with #error_code=otp_expired&error_description=... when a
// confirmation / reset link is expired or was already used. Show a friendly message.
function linkErrorFromHash(): string | null {
  if (typeof window === "undefined" || !window.location.hash.includes("error")) return null;
  const p = new URLSearchParams(window.location.hash.slice(1));
  const code = p.get("error_code");
  if (!code && !p.get("error")) return null;
  if (code === "otp_expired") return "That link has expired or was already used. Sign in, or request a new one.";
  return "That link is not valid. Please request a new one.";
}

function AuthPage() {
  const { user, signIn, signUp, requestPasswordReset, loading } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [captcha, setCaptcha] = useState<string | null>(null);
  const [captchaReset, setCaptchaReset] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const fails = useRef(0);
  const [lockedUntil, setLockedUntil] = useState(0);

  useEffect(() => {
    if (!loading && user) navigate({ to: "/" });
  }, [user, loading, navigate]);

  useEffect(() => {
    const msg = linkErrorFromHash();
    if (msg) {
      toast.error(msg);
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    const now = Date.now();
    if (now < lockedUntil) {
      toast.error(`Too many attempts. Try again in ${Math.ceil((lockedUntil - now) / 1000)}s.`);
      return;
    }
    const cleanEmail = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail) || cleanEmail.length > 254) {
      toast.error("Enter a valid email address.");
      return;
    }
    if (mode !== "forgot" && (password.length < (mode === "signup" ? PASSWORD_MIN : 1) || password.length > 128)) {
      toast.error(mode === "signup" ? `Use at least ${PASSWORD_MIN} characters.` : "Enter your password.");
      return;
    }
    if (turnstileEnabled && !captcha) {
      toast.error("Please complete the verification check.");
      return;
    }

    setSubmitting(true);
    const token = captcha ?? undefined;
    try {
      if (mode === "signin") {
        const { error } = await signIn(cleanEmail, password, token);
        if (error) {
          fails.current += 1;
          if (fails.current >= MAX_FAILS) {
            setLockedUntil(Date.now() + COOLDOWN_MS);
            fails.current = 0;
            toast.error("Too many failed attempts. Please wait a minute, or reset your password.");
          } else toast.error(error);
        } else fails.current = 0;
      } else if (mode === "signup") {
        const { error, needsConfirmation } = await signUp(cleanEmail, password, token);
        if (error) toast.error(error);
        else if (needsConfirmation) {
          // Same message whether or not the email already exists (no account enumeration).
          setNotice("Check your email. If this address can be registered, we've sent a confirmation link. If you already have an account, sign in or reset your password.");
          setMode("signin");
          setPassword("");
        }
      } else {
        const { error } = await requestPasswordReset(cleanEmail, token);
        if (error) toast.error(error);
        else {
          setNotice("If an account exists for that email, a reset link is on its way.");
          setMode("signin");
        }
      }
    } finally {
      setSubmitting(false);
      setCaptcha(null);
      setCaptchaReset((n) => n + 1);
    }
  };

  const title = mode === "signin" ? "Welcome back" : mode === "signup" ? "Create your fleet" : "Reset your password";
  const subtitle =
    mode === "signin" ? "Sign in to your control center." : mode === "signup" ? "One account, all your servers." : "We'll email you a reset link.";

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <div className="absolute right-4 top-4 z-50">
        <ThemeToggle />
      </div>
      {/* Left: branding panel */}
      <div className="glass relative hidden flex-col justify-between overflow-hidden border-r border-border/50 p-10 lg:flex">
        <Constellation className="pointer-events-none absolute -right-24 top-[42%] w-[100%] max-w-none -translate-y-1/2 opacity-60" />
        <div className="flex items-center gap-2.5">
          <div className="btn-glow relative flex h-9 w-9 items-center justify-center rounded-lg">
            <Activity className="h-5 w-5 text-primary-foreground" />
            <span className="status-dot absolute -right-1 -top-1 bg-success text-success" />
          </div>
          <div className="text-gradient font-display text-lg font-bold tracking-[0.16em]">FLEET</div>
        </div>

        <div className="relative space-y-8">
          <h1 className="text-5xl font-bold leading-[1.05] tracking-tight">
            Every server.
            <br />
            <span className="text-gradient">One screen.</span>
          </h1>
          <ul className="relative space-y-4 text-sm text-muted-foreground">
            <Feature icon={<Server className="h-4 w-4" />} title="Live inventory" desc="See every host, status, and resources at a glance." />
            <Feature icon={<Zap className="h-4 w-4" />} title="One-click updates" desc="Run apt/dnf upgrades across the fleet, see logs." />
            <Feature icon={<Terminal className="h-4 w-4" />} title="Remote commands" desc="Queue commands; agents execute and report back." />
          </ul>
        </div>

        <div className="relative font-mono text-xs text-muted-foreground">
          $ <span className="text-gradient">fleet</span> status --all
        </div>
      </div>

      {/* Right: form */}
      <div className="flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="mb-8 lg:hidden">
            <div className="flex items-center gap-2.5">
              <div className="btn-glow flex h-8 w-8 items-center justify-center rounded-lg">
                <Activity className="h-4 w-4 text-primary-foreground" />
              </div>
              <span className="text-gradient font-display text-base font-bold tracking-[0.16em]">FLEET</span>
            </div>
          </div>

          <h2 className="font-display text-3xl font-bold tracking-tight">{title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>

          {notice && (
            <div role="status" className="mt-4 rounded-md border border-primary/30 bg-primary/10 p-3 text-sm">
              {notice}
            </div>
          )}

          <form onSubmit={onSubmit} className="mt-8 space-y-4" noValidate>
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                required
                maxLength={254}
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
              />
            </div>
            {mode !== "forgot" && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="password">Password</Label>
                  {mode === "signin" && (
                    <button
                      type="button"
                      onClick={() => { setNotice(null); setMode("forgot"); }}
                      className="text-xs text-muted-foreground hover:text-foreground hover:underline"
                    >
                      Forgot password?
                    </button>
                  )}
                </div>
                <Input
                  id="password"
                  type="password"
                  required
                  minLength={mode === "signup" ? PASSWORD_MIN : undefined}
                  maxLength={128}
                  autoComplete={mode === "signin" ? "current-password" : "new-password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                />
                {mode === "signup" && (
                  <p className="text-xs text-muted-foreground">At least {PASSWORD_MIN} characters.</p>
                )}
              </div>
            )}

            <Turnstile onToken={setCaptcha} resetKey={captchaReset} />

            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? "..." : mode === "signin" ? "Sign in" : mode === "signup" ? "Create account" : "Send reset link"}
            </Button>

            {mode === "signup" && (
              <p className="text-xs text-muted-foreground">
                By creating an account you agree to the{" "}
                <Link to="/terms" className="underline">Terms</Link> and{" "}
                <Link to="/privacy" className="underline">Privacy Policy</Link>.
              </p>
            )}
          </form>

          <div className="mt-6 text-center text-sm text-muted-foreground">
            {mode === "forgot" ? (
              <button type="button" onClick={() => setMode("signin")} className="font-medium text-primary hover:underline">
                Back to sign in
              </button>
            ) : (
              <>
                {mode === "signin" ? "No account?" : "Already have one?"}{" "}
                <button
                  type="button"
                  onClick={() => { setNotice(null); setMode(mode === "signin" ? "signup" : "signin"); }}
                  className="font-medium text-primary hover:underline"
                >
                  {mode === "signin" ? "Sign up" : "Sign in"}
                </button>
              </>
            )}
          </div>

          <div className="mt-8 flex justify-center gap-4 text-xs text-muted-foreground">
            <Link to="/privacy" className="hover:underline">Privacy</Link>
            <Link to="/terms" className="hover:underline">Terms</Link>
          </div>
        </div>
      </div>
    </div>
  );
}

function Feature({ icon, title, desc }: { icon: React.ReactNode; title: string; desc: string }) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 flex h-6 w-6 flex-none items-center justify-center rounded-md bg-primary/10 text-primary">
        {icon}
      </span>
      <div>
        <div className="text-sm font-medium text-foreground">{title}</div>
        <div className="text-xs">{desc}</div>
      </div>
    </li>
  );
}
