import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useAuth } from "@/lib/auth";
import { authedPost } from "@/lib/servers";

export type Role = "viewer" | "member" | "admin" | "owner";
export type Workspace = { id: string; name: string; role: Role; require_mfa: boolean };

const RANK: Record<Role, number> = { viewer: 1, member: 2, admin: 3, owner: 4 };
const STORAGE_KEY = "fleet-workspace";

interface WorkspaceContextValue {
  workspaces: Workspace[];
  current: Workspace | null;
  loading: boolean;
  setCurrent: (id: string) => void;
  refresh: () => Promise<void>;
  /** Does the current user hold at least this role in the current workspace? (UI gating only;
   *  the database and API enforce the real rules.) */
  can: (min: Role) => boolean;
}

const Ctx = createContext<WorkspaceContextValue | undefined>(undefined);

function readStored(): string | null {
  try { return window.localStorage.getItem(STORAGE_KEY); } catch { return null; }
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { user, loading: authLoading, mfa } = useAuth();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!user || mfa.required) return; // the API refuses password-only sessions for 2FA accounts
    // Accepts pending invitations, creates a personal workspace if needed, returns memberships.
    const { data } = await authedPost<{ workspaces: Workspace[] }>("/api/team/claim", {});
    const list = data?.workspaces ?? [];
    setWorkspaces(list);
    setCurrentId((prev) => {
      const wanted = prev ?? readStored();
      return list.some((w) => w.id === wanted) ? wanted : (list[0]?.id ?? null);
    });
    setLoading(false);
  }, [user, mfa.required]);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      setWorkspaces([]);
      setCurrentId(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    refresh();
  }, [user?.id, authLoading, mfa.required]); // eslint-disable-line react-hooks/exhaustive-deps

  const setCurrent = useCallback((id: string) => {
    setCurrentId(id);
    try { window.localStorage.setItem(STORAGE_KEY, id); } catch { /* storage unavailable */ }
  }, []);

  const value = useMemo<WorkspaceContextValue>(() => {
    const current = workspaces.find((w) => w.id === currentId) ?? null;
    return {
      workspaces,
      current,
      loading,
      setCurrent,
      refresh,
      can: (min) => !!current && RANK[current.role] >= RANK[min],
    };
  }, [workspaces, currentId, loading, setCurrent, refresh]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWorkspace() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useWorkspace must be used within WorkspaceProvider");
  return ctx;
}
