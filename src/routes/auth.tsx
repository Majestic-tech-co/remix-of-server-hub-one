import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Activity, Server, Terminal, Zap } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Sign in — Fleet" },
      { name: "description", content: "Sign in to your server control center." },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const { user, signIn, signUp, loading } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!loading && user) navigate({ to: "/" });
  }, [user, loading, navigate]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    const fn = mode === "signin" ? signIn : signUp;
    const { error } = await fn(email, password);
    setSubmitting(false);
    if (error) {
      toast.error(error.message);
    } else if (mode === "signup") {
      toast.success("Account created. You're in.");
    }
  };

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      {/* Left: branding panel */}
      <div className="relative hidden flex-col justify-between border-r border-border/60 bg-card/40 p-10 lg:flex">
        <div className="flex items-center gap-2.5">
          <div className="relative flex h-9 w-9 items-center justify-center rounded-md bg-primary/15">
            <Activity className="h-5 w-5 text-primary" />
            <span className="absolute -right-0.5 -top-0.5 h-2 w-2 animate-pulse rounded-full bg-primary shadow-[0_0_8px_currentColor]" />
          </div>
          <div className="font-mono text-base font-semibold tracking-tight">FLEET</div>
        </div>

        <div className="space-y-8">
          <h1 className="text-4xl font-semibold leading-tight tracking-tight">
            Every server.
            <br />
            <span className="text-primary">One screen.</span>
          </h1>
          <ul className="space-y-4 text-sm text-muted-foreground">
            <Feature icon={<Server className="h-4 w-4" />} title="Live inventory" desc="See every host, status, and resources at a glance." />
            <Feature icon={<Zap className="h-4 w-4" />} title="One-click updates" desc="Run apt/dnf upgrades across the fleet, see logs." />
            <Feature icon={<Terminal className="h-4 w-4" />} title="Remote commands" desc="Queue commands; agents execute and report back." />
          </ul>
        </div>

        <div className="font-mono text-xs text-muted-foreground">
          $ <span className="text-primary">fleet</span> status --all
        </div>
      </div>

      {/* Right: form */}
      <div className="flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="mb-8 lg:hidden">
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/15">
                <Activity className="h-4 w-4 text-primary" />
              </div>
              <span className="font-mono text-sm font-semibold">FLEET</span>
            </div>
          </div>

          <h2 className="text-2xl font-semibold tracking-tight">
            {mode === "signin" ? "Welcome back" : "Create your fleet"}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {mode === "signin" ? "Sign in to your control center." : "One account, all your servers."}
          </p>

          <form onSubmit={onSubmit} className="mt-8 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                required
                minLength={6}
                autoComplete={mode === "signin" ? "current-password" : "new-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
              />
            </div>

            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? "..." : mode === "signin" ? "Sign in" : "Create account"}
            </Button>
          </form>

          <div className="mt-6 text-center text-sm text-muted-foreground">
            {mode === "signin" ? "No account?" : "Already have one?"}{" "}
            <button
              type="button"
              onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
              className="font-medium text-primary hover:underline"
            >
              {mode === "signin" ? "Sign up" : "Sign in"}
            </button>
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
