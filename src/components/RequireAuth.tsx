import { useEffect, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAuth } from "@/lib/auth";
import { Activity } from "lucide-react";
import { MfaChallenge } from "@/components/MfaChallenge";

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading, mfa } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!loading && !user) {
      navigate({ to: "/auth" });
    }
  }, [user, loading, navigate]);

  if (loading || !user) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Activity className="h-6 w-6 animate-pulse text-primary" />
      </div>
    );
  }

  // Password accepted but the code step is still pending: show only the code prompt.
  if (mfa.required) return <MfaChallenge />;

  return <>{children}</>;
}
