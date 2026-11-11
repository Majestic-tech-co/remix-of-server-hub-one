import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { LogOut, MailPlus, Plus, Trash2, UserMinus, Users } from "lucide-react";
import { RequireAuth } from "@/components/RequireAuth";
import { AppShell } from "@/components/AppShell";
import { useWorkspace, type Role } from "@/lib/workspace";
import { authedPost } from "@/lib/servers";
import { timeAgo } from "@/lib/format";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/team")({
  head: () => ({ meta: [{ title: "Team — Fleet" }] }),
  component: () => (
    <RequireAuth>
      <AppShell>
        <TeamPage />
      </AppShell>
    </RequireAuth>
  ),
});

type Member = { user_id: string; email: string; role: Role; created_at: string; is_you: boolean };
type Invite = { id: string; email: string; role: Exclude<Role, "owner">; created_at: string };

const ROLE_HELP: Record<Role, string> = {
  owner: "Everything, including managing admins and deleting the team",
  admin: "Add and edit servers and playbooks, invite people, read the audit log",
  member: "Run commands, playbooks and terminals; acknowledge alerts",
  viewer: "Read-only: servers, metrics and alerts",
};
const ROLE_BADGE: Record<Role, string> = {
  owner: "bg-primary/15 text-primary",
  admin: "bg-cyan/15 text-cyan",
  member: "bg-success/15 text-success",
  viewer: "bg-muted text-muted-foreground",
};

function RoleBadge({ role }: { role: Role }) {
  return <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] uppercase ${ROLE_BADGE[role]}`}>{role}</span>;
}

function TeamPage() {
  const { current, workspaces, setCurrent, refresh, can } = useWorkspace();
  const navigate = useNavigate();
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Exclude<Role, "owner">>("member");
  const [name, setName] = useState("");
  const [newTeam, setNewTeam] = useState("");
  const [confirmDelete, setConfirmDelete] = useState("");

  const myRole = current?.role ?? "viewer";
  const isOwner = myRole === "owner";

  const load = useCallback(async () => {
    if (!current) return;
    const { data, error } = await authedPost<{ members: Member[]; invites: Invite[] }>("/api/team/list", { workspace_id: current.id });
    if (error) toast.error(error);
    setMembers(data?.members ?? []);
    setInvites(data?.invites ?? []);
    setLoaded(true);
  }, [current]);

  useEffect(() => {
    setLoaded(false);
    setName(current?.name ?? "");
    setConfirmDelete("");
    load();
  }, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Run an API action; on success refresh the list.
  const act = async (path: string, body: unknown, ok?: string) => {
    setBusy(true);
    const { data, error } = await authedPost<Record<string, unknown>>(path, body);
    setBusy(false);
    if (error) { toast.error(error); return null; }
    if (ok) toast.success(ok);
    await load();
    return data ?? {};
  };

  const canManage = (m: Member) => !m.is_you && can("admin") && (isOwner || m.role === "member" || m.role === "viewer");
  const roleChoices: Role[] = isOwner ? ["owner", "admin", "member", "viewer"] : ["member", "viewer"];

  const invite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!current) return;
    const res = await act("/api/team/invite", { action: "create", workspace_id: current.id, email: inviteEmail, role: inviteRole });
    if (res) {
      toast.success(res.emailed ? "Invitation sent." : "Invitation saved. They'll join when they sign in with this email.");
      setInviteEmail("");
    }
  };

  const leave = async () => {
    if (!current || !window.confirm(`Leave "${current.name}"? You'll lose access to its servers.`)) return;
    const res = await act("/api/team/member", { action: "leave", workspace_id: current.id }, "You left the team.");
    if (res) { await refresh(); navigate({ to: "/" }); }
  };

  const createTeam = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await act("/api/team/workspace", { action: "create", name: newTeam }, "Team created.");
    if (res && (res as { workspace?: { id: string } }).workspace) {
      setNewTeam("");
      await refresh();
      setCurrent((res as { workspace: { id: string } }).workspace.id);
    }
  };

  const deleteTeam = async () => {
    if (!current) return;
    if (!window.confirm(`Permanently delete "${current.name}" and every server, command, playbook and log in it? This cannot be undone.`)) return;
    const res = await act("/api/team/workspace", { action: "delete", workspace_id: current.id, confirm_name: confirmDelete }, "Team deleted.");
    if (res) { await refresh(); navigate({ to: "/" }); }
  };

  if (!current) return <p className="text-sm text-muted-foreground">Loading…</p>;

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <h1 className="font-mono text-xs uppercase tracking-widest text-muted-foreground">// team</h1>
        <h2 className="mt-1 flex items-center gap-3 text-3xl font-semibold tracking-tight">
          {current.name} <RoleBadge role={myRole} />
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{ROLE_HELP[myRole]}.</p>
      </div>

      {/* Members */}
      <Card className="p-5">
        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          <Users className="h-3.5 w-3.5" /> Members {loaded && `(${members.length})`}
        </div>
        {!loaded ? (
          <p className="mt-4 text-sm text-muted-foreground">Loading…</p>
        ) : (
          <ul className="mt-4 divide-y divide-border/50">
            {members.map((m) => (
              <li key={m.user_id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">
                    {m.email} {m.is_you && <span className="font-normal text-muted-foreground">(you)</span>}
                  </div>
                  <div className="font-mono text-[11px] text-muted-foreground">joined {timeAgo(m.created_at)}</div>
                </div>
                {canManage(m) ? (
                  <select
                    value={m.role}
                    disabled={busy}
                    onChange={(e) => act("/api/team/member", { action: "set_role", workspace_id: current.id, user_id: m.user_id, role: e.target.value }, "Role updated.")}
                    aria-label={`Role for ${m.email}`}
                    className="rounded-md border border-border bg-background/60 px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-ring"
                  >
                    {roleChoices.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                ) : (
                  <RoleBadge role={m.role} />
                )}
                {canManage(m) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => window.confirm(`Remove ${m.email} from the team?`) && act("/api/team/member", { action: "remove", workspace_id: current.id, user_id: m.user_id }, "Member removed.")}
                    aria-label={`Remove ${m.email}`}
                  >
                    <UserMinus className="h-4 w-4" />
                  </Button>
                )}
                {m.is_you && (
                  <Button variant="ghost" size="sm" disabled={busy} onClick={leave}>
                    <LogOut className="h-4 w-4" /> Leave
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        <dl className="mt-4 grid gap-1 border-t border-border/50 pt-4 text-xs text-muted-foreground sm:grid-cols-2">
          {(Object.keys(ROLE_HELP) as Role[]).map((r) => (
            <div key={r}><dt className="inline font-mono uppercase text-foreground">{r}</dt> — {ROLE_HELP[r]}</div>
          ))}
        </dl>
      </Card>

      {/* Invite */}
      {can("admin") && (
        <Card className="p-5">
          <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            <MailPlus className="h-3.5 w-3.5" /> Invite someone
          </div>
          <form onSubmit={invite} className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
            <div className="space-y-1.5">
              <Label htmlFor="invite-email">Email</Label>
              <Input id="invite-email" type="email" required maxLength={254} value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="teammate@company.com" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="invite-role">Role</Label>
              <select
                id="invite-role"
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as Exclude<Role, "owner">)}
                className="h-9 w-full rounded-md border border-input bg-background/60 px-2 text-sm outline-none focus:ring-1 focus:ring-ring"
              >
                {isOwner && <option value="admin">admin</option>}
                <option value="member">member</option>
                <option value="viewer">viewer</option>
              </select>
            </div>
            <Button type="submit" disabled={busy}>Send invite</Button>
          </form>
          <p className="mt-3 text-xs text-muted-foreground">
            They join automatically when they sign in with this email address (after confirming it).
          </p>
          {invites.length > 0 && (
            <ul className="mt-4 divide-y divide-border/50 border-t border-border/50">
              {invites.map((i) => (
                <li key={i.id} className="flex items-center gap-3 py-2.5 text-sm">
                  <span className="min-w-0 flex-1 truncate">{i.email}</span>
                  <RoleBadge role={i.role} />
                  <span className="font-mono text-[11px] text-muted-foreground">{timeAgo(i.created_at)}</span>
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => act("/api/team/invite", { action: "revoke", invite_id: i.id }, "Invitation revoked.")}>
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {/* Rename + create */}
      <Card className="p-5">
        <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Team settings</div>
        {isOwner && (
          <form
            className="mt-4 flex gap-2"
            onSubmit={(e) => { e.preventDefault(); act("/api/team/workspace", { action: "rename", workspace_id: current.id, name }, "Team renamed.").then(refresh); }}
          >
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} aria-label="Team name" required />
            <Button type="submit" variant="secondary" disabled={busy || name.trim() === current.name}>Rename</Button>
          </form>
        )}
        <form onSubmit={createTeam} className="mt-4 flex gap-2">
          <Input value={newTeam} onChange={(e) => setNewTeam(e.target.value)} maxLength={100} placeholder="Create another team…" aria-label="New team name" required />
          <Button type="submit" variant="secondary" disabled={busy}><Plus className="h-4 w-4" /> Create</Button>
        </form>
        {workspaces.length > 1 && (
          <p className="mt-3 text-xs text-muted-foreground">You belong to {workspaces.length} teams. Switch between them from the sidebar.</p>
        )}
      </Card>

      {/* Danger zone */}
      {isOwner && (
        <Card className="border-destructive/40 p-5">
          <div className="font-mono text-[10px] uppercase tracking-widest text-destructive">Danger zone</div>
          <p className="mt-3 text-sm text-muted-foreground">
            Deleting the team permanently removes every server, command, playbook, alert and log in it. Agents stop reporting.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Input value={confirmDelete} onChange={(e) => setConfirmDelete(e.target.value)} placeholder={`Type "${current.name}" to confirm`} className="max-w-xs" aria-label="Confirm team name" maxLength={100} />
            <Button variant="destructive" disabled={busy || confirmDelete.trim() !== current.name} onClick={deleteTeam}>
              <Trash2 className="h-4 w-4" /> Delete team
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
