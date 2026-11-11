import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { friendlyError } from "@/lib/errors";

export type AuthResult = { error: string | null };
export type SignUpResult = AuthResult & { needsConfirmation?: boolean };

interface AuthContextValue {
  user: User | null;
  session: Session | null;
  loading: boolean;
  signIn: (email: string, password: string, captchaToken?: string) => Promise<AuthResult>;
  signUp: (email: string, password: string, captchaToken?: string) => Promise<SignUpResult>;
  requestPasswordReset: (email: string, captchaToken?: string) => Promise<AuthResult>;
  updatePassword: (password: string) => Promise<AuthResult>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      setUser(s?.user ?? null);
    });

    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setUser(data.session?.user ?? null);
      setLoading(false);
    });

    return () => sub.subscription.unsubscribe();
  }, []);

  const value: AuthContextValue = {
    user,
    session,
    loading,
    signIn: async (email, password, captchaToken) => {
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
        options: captchaToken ? { captchaToken } : undefined,
      });
      return { error: error ? friendlyError(error) : null };
    },
    signUp: async (email, password, captchaToken) => {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: `${window.location.origin}/`, captchaToken },
      });
      if (error) return { error: friendlyError(error) };
      // Supabase returns a user with no identities (and no error) when the email is
      // already registered, to avoid leaking which emails exist. Treat it exactly like
      // a normal sign-up so the UI does not reveal account existence.
      const needsConfirmation = !data.session;
      return { error: null, needsConfirmation };
    },
    requestPasswordReset: async (email, captchaToken) => {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/reset-password`,
        captchaToken,
      });
      // Always report success for unknown emails (no account enumeration);
      // only surface rate-limit / captcha style failures.
      if (error && /rate|captcha|network|fetch/i.test(error.message)) return { error: friendlyError(error) };
      return { error: null };
    },
    updatePassword: async (password) => {
      const { error } = await supabase.auth.updateUser({ password });
      return { error: error ? friendlyError(error) : null };
    },
    signOut: async () => {
      await supabase.auth.signOut();
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
