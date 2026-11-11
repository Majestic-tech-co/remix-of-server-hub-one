import { useWorkspace } from "@/lib/workspace";

const ROLE_LABEL = { owner: "Owner", admin: "Admin", member: "Member", viewer: "Viewer" } as const;

/** Shows which team you're working in, and lets you switch if you belong to more than one. */
export function WorkspaceSwitcher() {
  const { workspaces, current, setCurrent, loading } = useWorkspace();
  if (loading || !current) return null;

  return (
    <div className="mt-2 px-2 group-data-[collapsible=icon]:hidden">
      <div className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground">Team</div>
      {workspaces.length > 1 ? (
        <select
          value={current.id}
          onChange={(e) => setCurrent(e.target.value)}
          aria-label="Switch team"
          className="mt-1 w-full rounded-md border border-border bg-background/60 px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
        >
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>{w.name}</option>
          ))}
        </select>
      ) : (
        <div className="mt-1 truncate text-sm font-medium">{current.name}</div>
      )}
      <div className="mt-1 font-mono text-[10px] text-muted-foreground">{ROLE_LABEL[current.role]}</div>
    </div>
  );
}
