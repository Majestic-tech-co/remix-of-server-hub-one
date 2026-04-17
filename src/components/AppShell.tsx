import { Link, useNavigate } from "@tanstack/react-router";
import { LogOut, Server, Activity } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import type { ReactNode } from "react";

export function AppShell({ children }: { children: ReactNode }) {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-border/60 bg-background/80 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-6">
          <Link to="/" className="flex items-center gap-2.5">
            <div className="relative flex h-8 w-8 items-center justify-center rounded-md bg-primary/15">
              <Activity className="h-4 w-4 text-primary" />
              <span className="absolute -right-0.5 -top-0.5 h-2 w-2 animate-pulse rounded-full bg-primary shadow-[0_0_8px_currentColor]" />
            </div>
            <div className="flex flex-col leading-none">
              <span className="font-mono text-sm font-semibold tracking-tight">FLEET</span>
              <span className="font-mono text-[10px] text-muted-foreground">control center</span>
            </div>
          </Link>

          <nav className="flex items-center gap-1">
            <Link
              to="/"
              className="rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&.active]:bg-muted [&.active]:text-foreground"
              activeOptions={{ exact: true }}
            >
              <span className="inline-flex items-center gap-1.5">
                <Server className="h-3.5 w-3.5" /> Servers
              </span>
            </Link>
          </nav>

          <div className="flex items-center gap-3">
            <span className="hidden font-mono text-xs text-muted-foreground sm:inline">
              {user?.email}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                await signOut();
                navigate({ to: "/auth" });
              }}
            >
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8">{children}</main>
    </div>
  );
}
