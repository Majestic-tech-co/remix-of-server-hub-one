// Runs EVERY migration, in order, on a real Postgres engine (PGlite) with Supabase-style roles
// and a stub `auth` schema, then checks workspace isolation and the role matrix actually hold.
// Executed twice: with Supabase's "Automatically expose new tables" ON (worst case: every new
// table is granted to API roles) and OFF.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DIR = join(process.cwd(), "supabase", "migrations");
const TEAMS = "20261113000000_teams.sql";
const DENIED = /permission denied|row-level security|violates|row limit|does not exist|must keep/i;

// users
const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"; // owner  of W1
const B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"; // owner  of W2
const C = "cccccccc-cccc-cccc-cccc-cccccccccccc"; // viewer in W1
const D = "dddddddd-dddd-dddd-dddd-dddddddddddd"; // member in W1
const E = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee"; // admin  in W1
const F = "ffffffff-ffff-ffff-ffff-ffffffffffff"; // not in any workspace
// workspaces / servers / playbooks
const W1 = "11111111-aaaa-aaaa-aaaa-111111111111";
const W2 = "22222222-bbbb-bbbb-bbbb-222222222222";
const SA = "a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1"; // server in W1
const SB = "b1b1b1b1-b1b1-b1b1-b1b1-b1b1b1b1b1b1"; // server in W2
const SX = "c1c1c1c1-c1c1-c1c1-c1c1-c1c1c1c1c1c1"; // spare server in W1 (for delete tests)
const T1 = "71717171-7171-7171-7171-717171717171"; // playbook in W1
const T2 = "72727272-7272-7272-7272-727272727272"; // playbook in W2
const R1 = "81818181-8181-8181-8181-818181818181"; // run in W1
const R2 = "82828282-8282-8282-8282-828282828282"; // run in W2

async function boot(autoExpose: boolean, skipFrom?: string): Promise<PGlite> {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text);
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
    GRANT SELECT ON auth.users TO service_role;
    GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS
      $$ SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
    GRANT EXECUTE ON FUNCTION auth.jwt() TO anon, authenticated, service_role;
    CREATE TABLE auth.mfa_factors (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, status text NOT NULL);
  `);
  if (autoExpose) {
    await db.exec(`
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    `);
  }
  const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    if (skipFrom && f >= skipFrom) break;
    try {
      await db.exec(readFileSync(join(DIR, f), "utf8"));
    } catch (e) {
      throw new Error(`migration ${f} failed: ${(e as Error).message}`);
    }
  }
  return db;
}

type Role = "anon" | "authenticated" | "service_role";

describe.each([
  { autoExpose: true, label: "auto-expose ON" },
  { autoExpose: false, label: "auto-expose OFF" },
])("migrations + teams ($label)", ({ autoExpose }) => {
  let db: PGlite;

  const as = async (role: Role, uid: string | null, sql: string) => {
    await db.exec(`SET ROLE ${role}; SELECT set_config('request.jwt.claim.sub', '${uid ?? ""}', false), set_config('request.jwt.claims', '{}', false);`);
    try {
      return await db.query<Record<string, unknown>>(sql);
    } finally {
      await db.exec("RESET ROLE");
    }
  };
  const admin = (sql: string) => db.query<Record<string, unknown>>(sql);
  const seed = async (sql: string) => { await db.exec(`SET ROLE service_role; ${sql}; RESET ROLE;`); };
  const user = (u: string, sql: string) => as("authenticated", u, sql);
  const ids = (r: { rows: Record<string, unknown>[] }, col = "id") => r.rows.map((x) => x[col]);

  beforeAll(async () => {
    db = await boot(autoExpose);
    await admin(`INSERT INTO auth.users (id, email) VALUES
      ('${A}','a@t.dev'),('${B}','b@t.dev'),('${C}','c@t.dev'),('${D}','d@t.dev'),('${E}','e@t.dev'),('${F}','f@t.dev')`);
    await seed(`
      INSERT INTO public.workspaces (id,name,created_by) VALUES ('${W1}','Team One','${A}'),('${W2}','Team Two','${B}');
      INSERT INTO public.workspace_members (workspace_id,user_id,role) VALUES
        ('${W1}','${A}','owner'),('${W1}','${C}','viewer'),('${W1}','${D}','member'),('${W1}','${E}','admin'),
        ('${W2}','${B}','owner');
      INSERT INTO public.servers (id,user_id,workspace_id,name,agent_token_hash,last_seen_at) VALUES
        ('${SA}','${A}','${W1}','alpha','hash-a', now()),
        ('${SX}','${A}','${W1}','spare','hash-x', now()),
        ('${SB}','${B}','${W2}','bravo','hash-b', now());
      INSERT INTO public.automation_tasks (id,user_id,workspace_id,name,script_content) VALUES
        ('${T1}','${E}','${W1}','p1','echo'),('${T2}','${B}','${W2}','p2','echo');
      INSERT INTO public.automation_runs (id,user_id,workspace_id,task_id) VALUES
        ('${R1}','${D}','${W1}','${T1}'),('${R2}','${B}','${W2}','${T2}');
      INSERT INTO public.metrics (server_id,cpu_percent,memory_percent,disk_percent) VALUES ('${SA}',10,10,10);`);
  }, 120_000);
  afterAll(async () => { await db?.close(); });

  // ───────────── structure ─────────────
  it("every public table has row-level security enabled", async () => {
    const r = await admin(`SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                           WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity`);
    expect(r.rows).toEqual([]);
  });

  it("signed-out (anon) users can read and write nothing", async () => {
    for (const t of ["servers", "metrics", "commands", "terminal_sessions", "automation_tasks", "automation_runs",
                     "task_logs", "audit_log", "alerts", "workspaces", "workspace_members", "workspace_invites"]) {
      await expect(as("anon", null, `SELECT * FROM public.${t}`), t).rejects.toThrow(DENIED);
    }
    await expect(as("anon", null, `SELECT public.has_role('${W1}','viewer')`)).rejects.toThrow(DENIED);
  });

  it("a signed-in user with no workspace sees nothing", async () => {
    for (const t of ["servers", "workspaces", "workspace_members", "automation_tasks", "alerts"]) {
      expect((await user(F, `SELECT count(*)::int AS n FROM public.${t}`)).rows).toEqual([{ n: 0 }]);
    }
  });

  // ───────────── workspace isolation ─────────────
  it("users only see their own workspace's servers, playbooks and members", async () => {
    expect(ids(await user(A, `SELECT id FROM public.servers ORDER BY name`))).toEqual([SA, SX]);
    expect(ids(await user(B, `SELECT id FROM public.servers`))).toEqual([SB]);
    expect(ids(await user(A, `SELECT id FROM public.workspaces`))).toEqual([W1]);
    expect(ids(await user(B, `SELECT id FROM public.automation_tasks`))).toEqual([T2]);
    expect((await user(B, `SELECT * FROM public.workspace_members`)).rows).toHaveLength(1);
    expect((await user(A, `SELECT * FROM public.workspace_members`)).rows).toHaveLength(4);
    expect((await user(B, `SELECT * FROM public.metrics`)).rows).toHaveLength(0);
  });

  it("the agent token hash is unreadable and servers cannot be created or re-homed from the browser", async () => {
    await expect(user(E, `SELECT agent_token_hash FROM public.servers`)).rejects.toThrow(DENIED);
    await expect(user(E, `SELECT * FROM public.servers`)).rejects.toThrow(DENIED);
    await expect(user(E, `INSERT INTO public.servers (user_id,workspace_id,name,agent_token_hash) VALUES ('${E}','${W1}','x','h')`)).rejects.toThrow(DENIED);
    await expect(user(E, `UPDATE public.servers SET agent_token_hash='evil'`)).rejects.toThrow(DENIED);
    await expect(user(E, `UPDATE public.servers SET workspace_id='${W2}'`)).rejects.toThrow(DENIED);
    await expect(user(E, `UPDATE public.servers SET user_id='${E}'`)).rejects.toThrow(DENIED);
  });

  // ───────────── role matrix ─────────────
  it("servers: everyone reads, only admins+ change or delete", async () => {
    expect(ids(await user(C, `SELECT id FROM public.servers WHERE id='${SA}'`))).toEqual([SA]); // viewer reads
    for (const who of [C, D]) {
      expect((await user(who, `UPDATE public.servers SET connection_notes='x' WHERE id='${SA}' RETURNING id`)).rows).toHaveLength(0);
      expect((await user(who, `DELETE FROM public.servers WHERE id='${SX}' RETURNING id`)).rows).toHaveLength(0);
    }
    expect((await user(E, `UPDATE public.servers SET connection_notes='ssh' WHERE id='${SA}' RETURNING id`)).rows).toHaveLength(1);
    expect((await user(E, `UPDATE public.servers SET connection_notes='pwn' WHERE id='${SB}' RETURNING id`)).rows).toHaveLength(0); // other workspace
    expect((await user(E, `DELETE FROM public.servers WHERE id='${SB}' RETURNING id`)).rows).toHaveLength(0);
  });

  it("commands: members+ only, on their own workspace's servers, every one audited", async () => {
    await expect(user(C, `INSERT INTO public.commands (server_id,user_id,command) VALUES ('${SA}','${C}','id')`)).rejects.toThrow(DENIED); // viewer
    await expect(user(D, `INSERT INTO public.commands (server_id,user_id,command) VALUES ('${SB}','${D}','id')`)).rejects.toThrow(DENIED); // other workspace
    await expect(user(D, `INSERT INTO public.commands (server_id,user_id,command) VALUES ('${SA}','${A}','id')`)).rejects.toThrow(DENIED); // impersonation
    await user(D, `INSERT INTO public.commands (server_id,user_id,command) VALUES ('${SA}','${D}','uptime')`);
    await expect(user(D, `UPDATE public.commands SET status='completed'`)).rejects.toThrow(DENIED);

    expect((await user(C, `SELECT * FROM public.commands`)).rows).toHaveLength(0); // viewers can't read commands
    expect((await user(A, `SELECT * FROM public.commands`)).rows).toHaveLength(1);
    expect((await user(B, `SELECT * FROM public.commands`)).rows).toHaveLength(0);

    // audit: admins/owners see the whole workspace log, members only their own events, viewers/outsiders nothing
    const adminSees = await user(E, `SELECT action, detail->>'command' AS cmd FROM public.audit_log WHERE action='command.queued'`);
    expect(adminSees.rows).toEqual([{ action: "command.queued", cmd: "uptime" }]);
    expect((await user(D, `SELECT * FROM public.audit_log`)).rows).toHaveLength(1);        // their own event
    expect((await user(C, `SELECT * FROM public.audit_log`)).rows).toHaveLength(0);
    expect((await user(B, `SELECT * FROM public.audit_log`)).rows).toHaveLength(0);
    await expect(user(E, `DELETE FROM public.audit_log`)).rejects.toThrow(DENIED);
    await expect(user(E, `INSERT INTO public.audit_log (user_id,action) VALUES ('${E}','x')`)).rejects.toThrow(DENIED);

    // admins can prune history, members cannot
    expect((await user(D, `DELETE FROM public.commands RETURNING id`)).rows).toHaveLength(0);
    expect((await user(E, `DELETE FROM public.commands RETURNING id`)).rows).toHaveLength(1);
  });

  it("metrics: viewers read, nobody writes from the browser", async () => {
    expect((await user(C, `SELECT * FROM public.metrics`)).rows).toHaveLength(1);
    await expect(user(E, `INSERT INTO public.metrics (server_id,cpu_percent) VALUES ('${SA}',1)`)).rejects.toThrow(DENIED);
    await expect(user(E, `INSERT INTO public.terminal_sessions (server_id,user_id) VALUES ('${SA}','${E}')`)).rejects.toThrow(DENIED);
  });

  it("terminal sessions: members see only their own", async () => {
    await seed(`INSERT INTO public.terminal_sessions (server_id,user_id) VALUES ('${SA}','${D}'),('${SA}','${E}')`);
    expect((await user(D, `SELECT * FROM public.terminal_sessions`)).rows).toHaveLength(1);
    expect((await user(C, `SELECT * FROM public.terminal_sessions`)).rows).toHaveLength(0);
    expect((await user(B, `SELECT * FROM public.terminal_sessions`)).rows).toHaveLength(0);
  });

  it("playbooks: admins write, members run them, viewers only read; no cross-workspace use", async () => {
    expect(ids(await user(C, `SELECT id FROM public.automation_tasks`))).toEqual([T1]);
    await expect(user(D, `INSERT INTO public.automation_tasks (user_id,workspace_id,name,script_content) VALUES ('${D}','${W1}','n','echo')`)).rejects.toThrow(DENIED);
    await expect(user(C, `INSERT INTO public.automation_tasks (user_id,workspace_id,name,script_content) VALUES ('${C}','${W1}','n','echo')`)).rejects.toThrow(DENIED);
    await expect(user(E, `INSERT INTO public.automation_tasks (user_id,workspace_id,name,script_content) VALUES ('${E}','${W2}','n','echo')`)).rejects.toThrow(DENIED);
    await user(E, `INSERT INTO public.automation_tasks (user_id,workspace_id,name,script_content) VALUES ('${E}','${W1}','n','echo')`);
    expect((await user(D, `UPDATE public.automation_tasks SET name='x' RETURNING id`)).rows).toHaveLength(0);

    // runs
    await user(D, `INSERT INTO public.automation_runs (user_id,workspace_id,task_id) VALUES ('${D}','${W1}','${T1}')`);
    await expect(user(C, `INSERT INTO public.automation_runs (user_id,workspace_id,task_id) VALUES ('${C}','${W1}','${T1}')`)).rejects.toThrow(DENIED);
    await expect(user(D, `INSERT INTO public.automation_runs (user_id,workspace_id,task_id) VALUES ('${D}','${W1}','${T2}')`)).rejects.toThrow(DENIED); // other workspace's playbook
    await expect(user(D, `INSERT INTO public.automation_runs (user_id,workspace_id,task_id) VALUES ('${D}','${W2}','${T2}')`)).rejects.toThrow(DENIED); // not a member of W2

    // logs: server + run must be in the same workspace
    await user(D, `INSERT INTO public.task_logs (user_id,run_id,server_id) VALUES ('${D}','${R1}','${SA}')`);
    await expect(user(D, `INSERT INTO public.task_logs (user_id,run_id,server_id) VALUES ('${D}','${R2}','${SA}')`)).rejects.toThrow(DENIED);
    await expect(user(D, `INSERT INTO public.task_logs (user_id,run_id,server_id) VALUES ('${D}','${R1}','${SB}')`)).rejects.toThrow(DENIED);
    expect((await user(C, `SELECT * FROM public.task_logs`)).rows).toHaveLength(0); // viewers don't read logs
  });

  it("alerts: raised per workspace, viewers read, members acknowledge, auto-resolve", async () => {
    await seed(`INSERT INTO public.metrics (server_id,cpu_percent,memory_percent,disk_percent) VALUES ('${SA}',95,10,10)`);
    await admin(`SELECT public.evaluate_alerts()`);
    await admin(`SELECT public.evaluate_alerts()`); // twice: no duplicates
    const open = await user(C, `SELECT kind, message FROM public.alerts WHERE resolved_at IS NULL`);
    expect(open.rows).toEqual([{ kind: "cpu", message: "alpha cpu usage is at 95%" }]);
    expect((await user(B, `SELECT * FROM public.alerts`)).rows).toHaveLength(0);

    expect((await user(C, `UPDATE public.alerts SET acknowledged = true RETURNING id`)).rows).toHaveLength(0); // viewer
    expect((await user(D, `UPDATE public.alerts SET acknowledged = true RETURNING id`)).rows).toHaveLength(1); // member
    await expect(user(D, `UPDATE public.alerts SET message = 'x'`)).rejects.toThrow(DENIED);
    await expect(user(E, `DELETE FROM public.alerts`)).rejects.toThrow(DENIED);

    await admin(`UPDATE public.metrics SET cpu_percent = 40`);
    await admin(`SELECT public.evaluate_alerts()`);
    expect((await user(C, `SELECT resolved_at IS NOT NULL AS done FROM public.alerts WHERE kind='cpu'`)).rows).toEqual([{ done: true }]);

    await admin(`UPDATE public.servers SET last_seen_at = now() - interval '10 minutes' WHERE id = '${SB}'`);
    await admin(`SELECT public.evaluate_alerts()`);
    expect((await user(B, `SELECT kind FROM public.alerts WHERE resolved_at IS NULL`)).rows).toEqual([{ kind: "offline" }]);
    await admin(`UPDATE public.servers SET last_seen_at = now() WHERE id = '${SB}'`);
    await admin(`SELECT public.evaluate_alerts()`);
    expect((await user(B, `SELECT kind FROM public.alerts WHERE resolved_at IS NULL`)).rows).toEqual([]);
  });

  // ───────────── membership management ─────────────
  it("members list is readable by the team, writable only by server routes", async () => {
    expect((await user(C, `SELECT * FROM public.workspace_members`)).rows).toHaveLength(4);
    await expect(user(A, `INSERT INTO public.workspace_members (workspace_id,user_id,role) VALUES ('${W1}','${F}','owner')`)).rejects.toThrow(DENIED);
    await expect(user(A, `UPDATE public.workspace_members SET role='owner' WHERE user_id='${C}'`)).rejects.toThrow(DENIED);
    await expect(user(F, `INSERT INTO public.workspace_members (workspace_id,user_id,role) VALUES ('${W1}','${F}','viewer')`)).rejects.toThrow(DENIED);
    await expect(user(A, `UPDATE public.workspaces SET name='x'`)).rejects.toThrow(DENIED);
  });

  it("invites are visible to admins only", async () => {
    await seed(`INSERT INTO public.workspace_invites (workspace_id,email,role,invited_by) VALUES ('${W1}','new@t.dev','member','${E}')`);
    expect((await user(E, `SELECT * FROM public.workspace_invites`)).rows).toHaveLength(1);
    for (const who of [D, C, B, F]) expect((await user(who, `SELECT * FROM public.workspace_invites`)).rows).toHaveLength(0);
    await expect(seed(`INSERT INTO public.workspace_invites (workspace_id,email,role) VALUES ('${W1}','NEW@t.dev','viewer')`)).rejects.toThrow(/duplicate|unique/i);
  });

  it("a workspace can never lose its last owner", async () => {
    await expect(seed(`UPDATE public.workspace_members SET role='admin' WHERE workspace_id='${W1}' AND user_id='${A}'`)).rejects.toThrow(DENIED);
    await expect(seed(`DELETE FROM public.workspace_members WHERE workspace_id='${W1}' AND user_id='${A}'`)).rejects.toThrow(DENIED);
    // with a second owner it is fine
    await seed(`UPDATE public.workspace_members SET role='owner' WHERE workspace_id='${W1}' AND user_id='${E}'`);
    await seed(`UPDATE public.workspace_members SET role='admin' WHERE workspace_id='${W1}' AND user_id='${A}'`);
    await seed(`UPDATE public.workspace_members SET role='owner' WHERE workspace_id='${W1}' AND user_id='${A}'`);
    await seed(`UPDATE public.workspace_members SET role='admin' WHERE workspace_id='${W1}' AND user_id='${E}'`);
  });

  // ───────────── limits, maintenance, lifecycle ─────────────
  it("per-user row caps stop bulk inserts", async () => {
    await expect(user(E, `INSERT INTO public.automation_tasks (user_id,workspace_id,name,script_content)
                           SELECT '${E}','${W1}','t'||g,'echo' FROM generate_series(1,501) g`)).rejects.toThrow(/row limit/i);
  }, 60_000); // 501 rows through RLS on an in-process WebAssembly Postgres; real Postgres is far faster

  it("maintenance functions are not callable from the API", async () => {
    await expect(user(A, `SELECT public.purge_old_data()`)).rejects.toThrow(DENIED);
    await expect(as("anon", null, `SELECT public.evaluate_alerts()`)).rejects.toThrow(DENIED);
  });

  it("purge fails stuck commands and deletes old metrics", async () => {
    await admin(`INSERT INTO public.commands (id,server_id,user_id,command,status,started_at)
                 VALUES ('33333333-3333-3333-3333-333333333333','${SA}','${D}','sleep','running', now() - interval '3 hours')`);
    await admin(`INSERT INTO public.metrics (server_id,cpu_percent,recorded_at) VALUES ('${SA}',1, now() - interval '40 days')`);
    await admin(`SELECT public.purge_old_data()`);
    expect((await admin(`SELECT status FROM public.commands WHERE id='33333333-3333-3333-3333-333333333333'`)).rows).toEqual([{ status: "failed" }]);
    expect((await admin(`SELECT count(*)::int AS n FROM public.metrics WHERE recorded_at < now() - interval '30 days'`)).rows).toEqual([{ n: 0 }]);
  });

  it("an admin deleting a server is audited with who did it", async () => {
    await user(E, `DELETE FROM public.servers WHERE id='${SX}'`);
    const r = await user(E, `SELECT user_id, detail->>'name' AS name FROM public.audit_log WHERE action='server.deleted'`);
    expect(r.rows).toEqual([{ user_id: E, name: "spare" }]);
  });

  it("a member leaving keeps the team's history; the sole owner of a team cannot just vanish", async () => {
    // D (member) is deleted: membership goes, their commands stay with user_id NULL
    await admin(`DELETE FROM auth.users WHERE id = '${D}'`);
    expect((await admin(`SELECT count(*)::int AS n FROM public.workspace_members WHERE user_id='${D}'`)).rows).toEqual([{ n: 0 }]);
    expect((await admin(`SELECT count(*)::int AS n FROM public.commands WHERE id='33333333-3333-3333-3333-333333333333' AND user_id IS NULL`)).rows).toEqual([{ n: 1 }]);
    expect((await admin(`SELECT count(*)::int AS n FROM public.servers WHERE id='${SA}'`)).rows).toEqual([{ n: 1 }]);
    // A is the only owner of W1 which still has other members: account removal is blocked
    await expect(admin(`DELETE FROM auth.users WHERE id = '${A}'`)).rejects.toThrow(DENIED);
  });

  it("deleting a workspace removes all its data without errors or phantom audit entries", async () => {
    await admin(`DELETE FROM public.workspaces WHERE id = '${W2}'`);
    for (const t of ["servers", "automation_tasks", "automation_runs", "workspace_members", "alerts"]) {
      expect((await admin(`SELECT count(*)::int AS n FROM public.${t} WHERE workspace_id='${W2}'`)).rows, t).toEqual([{ n: 0 }]);
    }
    expect((await admin(`SELECT count(*)::int AS n FROM public.audit_log WHERE workspace_id='${W2}'`)).rows).toEqual([{ n: 0 }]);
    expect((await admin(`SELECT count(*)::int AS n FROM public.servers WHERE id='${SB}'`)).rows).toEqual([{ n: 0 }]);
    // now B has no workspace and may be deleted
    await admin(`DELETE FROM auth.users WHERE id = '${B}'`);
  });
});

// ───────────── upgrading existing single-user data ─────────────
describe("teams migration upgrades existing data", () => {
  it("moves each user's data into their own personal workspace (as owner) and isolates them", async () => {
    const db = await boot(false, TEAMS); // everything BEFORE teams
    const U1 = "10000000-0000-0000-0000-000000000001";
    const U2 = "20000000-0000-0000-0000-000000000002";
    const U3 = "30000000-0000-0000-0000-000000000003"; // has no data
    await db.exec(`
      INSERT INTO auth.users (id,email) VALUES ('${U1}','u1@t.dev'),('${U2}','u2@t.dev'),('${U3}','u3@t.dev');
      INSERT INTO public.servers (id,user_id,name,agent_token_hash,last_seen_at) VALUES
        ('c0000000-0000-0000-0000-000000000001','${U1}','s1','h1', now()),
        ('c0000000-0000-0000-0000-000000000002','${U2}','s2','h2', now());
      INSERT INTO public.automation_tasks (id,user_id,name,script_content) VALUES
        ('d0000000-0000-0000-0000-000000000001','${U1}','p1','echo');
      INSERT INTO public.automation_runs (id,user_id,task_id) VALUES
        ('e0000000-0000-0000-0000-000000000001','${U1}','d0000000-0000-0000-0000-000000000001');
      INSERT INTO public.commands (server_id,user_id,command) VALUES ('c0000000-0000-0000-0000-000000000001','${U1}','uptime');
    `);
    await db.exec(readFileSync(join(DIR, TEAMS), "utf8"));

    const ws = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.workspaces`);
    expect(ws.rows[0].n).toBe(2); // U3 has no data → gets a workspace on first sign-in instead
    const owners = await db.query<{ user_id: string; role: string }>(`SELECT user_id, role FROM public.workspace_members ORDER BY user_id`);
    expect(owners.rows).toEqual([{ user_id: U1, role: "owner" }, { user_id: U2, role: "owner" }]);

    // every row landed in its owner's workspace, none in the other's
    const mapped = await db.query<{ same: boolean }>(`
      SELECT bool_and(s.workspace_id = m.workspace_id) AS same
        FROM public.servers s JOIN public.workspace_members m ON m.user_id = s.user_id`);
    expect(mapped.rows[0].same).toBe(true);
    const task = await db.query<{ ok: boolean }>(`
      SELECT (t.workspace_id = r.workspace_id AND t.workspace_id = s.workspace_id) AS ok
        FROM public.automation_tasks t, public.automation_runs r, public.servers s WHERE s.user_id = '${U1}'`);
    expect(task.rows[0].ok).toBe(true);

    // old command history survived and is now audited-readable only through the workspace rules
    expect((await db.query(`SELECT 1 FROM public.commands`)).rows).toHaveLength(1);

    // and the new rules apply immediately: U2 cannot see U1's server
    await db.exec(`SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub','${U2}',false);`);
    const seen = await db.query<{ name: string }>(`SELECT name FROM public.servers`);
    await db.exec(`RESET ROLE`);
    expect(seen.rows).toEqual([{ name: "s2" }]);
    await db.close();
  }, 120_000);
});

// ───────────── two-factor enforcement ─────────────
describe("two-factor (TOTP) enforcement", () => {
  let db: PGlite;
  const P = "90000000-0000-0000-0000-000000000001"; // has a verified factor
  const Q = "90000000-0000-0000-0000-000000000002"; // no factor
  const R = "90000000-0000-0000-0000-000000000003"; // only an UNVERIFIED (half-finished) factor
  const WA = "91000000-0000-0000-0000-00000000000a"; // normal team
  const WB = "91000000-0000-0000-0000-00000000000b"; // team that requires 2FA
  const SVA = "92000000-0000-0000-0000-00000000000a";
  const SVB = "92000000-0000-0000-0000-00000000000b";

  // run as a signed-in user whose session is aal1 (password only) or aal2 (code entered)
  const asUser = async (uid: string, aal: "aal1" | "aal2", sql: string) => {
    await db.exec(`SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub','${uid}',false), set_config('request.jwt.claims','{"aal":"${aal}"}',false);`);
    try {
      return await db.query<Record<string, unknown>>(sql);
    } finally {
      await db.exec("RESET ROLE");
    }
  };

  beforeAll(async () => {
    db = await boot(false);
    await db.exec(`
      INSERT INTO auth.users (id,email) VALUES ('${P}','p@t.dev'),('${Q}','q@t.dev'),('${R}','r@t.dev');
      INSERT INTO auth.mfa_factors (user_id,status) VALUES ('${P}','verified'),('${R}','unverified');
      SET ROLE service_role;
      INSERT INTO public.workspaces (id,name,created_by,require_mfa) VALUES
        ('${WA}','Normal','${P}',false),('${WB}','Strict','${P}',true);
      INSERT INTO public.workspace_members (workspace_id,user_id,role) VALUES
        ('${WA}','${P}','owner'),('${WA}','${Q}','member'),('${WA}','${R}','member'),
        ('${WB}','${P}','owner'),('${WB}','${Q}','member'),('${WB}','${R}','member');
      INSERT INTO public.servers (id,user_id,workspace_id,name,agent_token_hash) VALUES
        ('${SVA}','${P}','${WA}','normal-srv','ha'),('${SVB}','${P}','${WB}','strict-srv','hb');
      RESET ROLE;`);
  }, 120_000);
  afterAll(async () => { await db?.close(); });

  const names = async (uid: string, aal: "aal1" | "aal2") =>
    (await asUser(uid, aal, `SELECT name FROM public.servers ORDER BY name`)).rows.map((r) => r.name);

  it("a user with a verified factor gets NOTHING on a password-only (aal1) session", async () => {
    expect(await names(P, "aal1")).toEqual([]);
    expect((await asUser(P, "aal1", `SELECT * FROM public.workspaces`)).rows).toHaveLength(0);
    expect((await asUser(P, "aal1", `SELECT * FROM public.workspace_members`)).rows).toHaveLength(0);
  });

  it("…and cannot write either", async () => {
    await expect(asUser(P, "aal1", `INSERT INTO public.commands (server_id,user_id,command) VALUES ('${SVA}','${P}','id')`))
      .rejects.toThrow(DENIED);
    expect((await asUser(P, "aal1", `UPDATE public.servers SET connection_notes='x' RETURNING id`)).rows).toHaveLength(0);
  });

  it("after entering a code (aal2) access is normal", async () => {
    expect(await names(P, "aal2")).toEqual(["normal-srv", "strict-srv"]);
    await asUser(P, "aal2", `INSERT INTO public.commands (server_id,user_id,command) VALUES ('${SVA}','${P}','uptime')`);
  });

  it("own-row policies (audit log, terminal sessions) are also protected", async () => {
    expect((await asUser(P, "aal2", `SELECT * FROM public.audit_log`)).rows.length).toBeGreaterThan(0);
    expect((await asUser(P, "aal1", `SELECT * FROM public.audit_log`)).rows).toHaveLength(0);
  });

  it("users without a verified factor are unaffected (a half-finished setup does not lock them out)", async () => {
    expect(await names(Q, "aal1")).toEqual(["normal-srv"]);
    expect(await names(R, "aal1")).toEqual(["normal-srv"]);
  });

  it("a team that requires 2FA hides itself from members without it, but not from members with it", async () => {
    expect(await names(Q, "aal1")).not.toContain("strict-srv");
    expect(await names(R, "aal1")).not.toContain("strict-srv");
    expect(await names(P, "aal2")).toContain("strict-srv");
  });

  it("once a member verifies a factor they get into the strict team (only after entering a code)", async () => {
    await db.exec(`INSERT INTO auth.mfa_factors (user_id,status) VALUES ('${Q}','verified')`);
    expect(await names(Q, "aal1")).toEqual([]);                          // password only: nothing at all now
    expect(await names(Q, "aal2")).toEqual(["normal-srv", "strict-srv"]); // with a code: both teams
  });

  it("the browser cannot flip the requirement", async () => {
    await expect(asUser(P, "aal2", `UPDATE public.workspaces SET require_mfa=false`)).rejects.toThrow(DENIED);
  });

  it("the helper functions are not callable by signed-out users", async () => {
    await db.exec(`SET ROLE anon`);
    await expect(db.query(`SELECT public.mfa_ok()`)).rejects.toThrow(DENIED);
    await db.exec(`RESET ROLE`);
  });
});

// ───────────── terminal polling functions ─────────────
describe("terminal poll functions (framing, atomicity, access)", () => {
  let db: PGlite;
  const U = "a0000000-0000-0000-0000-000000000001";
  const WS = "a1000000-0000-0000-0000-000000000001";
  const SRV = "a2000000-0000-0000-0000-000000000001";
  const OTHER = "a2000000-0000-0000-0000-000000000002";
  const SES = "a3000000-0000-0000-0000-000000000001";

  // the API routes call these as the service role
  const svc = async (sql: string) => {
    await db.exec("SET ROLE service_role");
    try { return await db.query<Record<string, unknown>>(sql); } finally { await db.exec("RESET ROLE"); }
  };
  const client = async (ack: number, input: string | null, close = false, cols: number | null = null) =>
    (await svc(`SELECT * FROM public.terminal_client_poll('${SES}','${U}',${ack},${input === null ? "NULL" : `'${input}'`},${cols ?? "NULL"},NULL,${close})`)).rows[0];
  const agent = async (acks: object, outputs: object[]) =>
    (await svc(`SELECT public.terminal_agent_poll('${SRV}','${JSON.stringify(acks)}'::jsonb,'${JSON.stringify(outputs)}'::jsonb) AS r`)).rows[0].r as {
      sessions: { id: string; status: string; input_b64: string }[]; closed: string[];
    };

  beforeAll(async () => {
    db = await boot(false);
    await db.exec(`
      INSERT INTO auth.users (id,email) VALUES ('${U}','u@t.dev');
      SET ROLE service_role;
      INSERT INTO public.workspaces (id,name,created_by) VALUES ('${WS}','W','${U}');
      INSERT INTO public.workspace_members (workspace_id,user_id,role) VALUES ('${WS}','${U}','owner');
      INSERT INTO public.servers (id,user_id,workspace_id,name,agent_token_hash) VALUES
        ('${SRV}','${U}','${WS}','s1','h1'),('${OTHER}','${U}','${WS}','s2','h2');
      INSERT INTO public.terminal_sessions (id,server_id,user_id) VALUES ('${SES}','${SRV}','${U}');
      RESET ROLE;`);
  }, 120_000);
  afterAll(async () => { await db?.close(); });

  it("the functions are not callable from the browser or signed-out users", async () => {
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`SET ROLE ${role}`);
      await expect(db.query(`SELECT public.terminal_agent_poll('${SRV}','{}'::jsonb,'[]'::jsonb)`)).rejects.toThrow(DENIED);
      await expect(db.query(`SELECT * FROM public.terminal_client_poll('${SES}','${U}',0,NULL,NULL,NULL,false)`)).rejects.toThrow(DENIED);
      await db.exec(`RESET ROLE`);
    }
  });

  it("keystroke chunks are stored one per line, so several can be decoded separately", async () => {
    await client(0, "QQ==");   // 'A' (padded)
    await client(0, "Qg==");   // 'B' (padded) — used to corrupt/lose everything after the first chunk
    const r = await agent({}, []);
    const mine = r.sessions.find((s) => s.id === SES)!;
    expect(mine.input_b64).toBe("QQ==\nQg==\n");
    // an agent that splits on newlines and decodes each part recovers both characters
    const bytes = mine.input_b64.split("\n").filter(Boolean).map((p) => Buffer.from(p, "base64").toString());
    expect(bytes.join("")).toBe("AB");
  });

  it("acknowledging consumed input drops exactly those chunks and keeps newer ones", async () => {
    await agent({ [SES]: "QQ==\nQg==\n".length }, []);          // agent consumed A and B
    expect((await agent({}, [])).sessions.find((s) => s.id === SES)!.input_b64).toBe("");
    await client(0, "Qw==");                                      // C arrives after
    await agent({ [SES]: 5 }, []);                                // agent had only seen up to its 5-char chunk
    expect((await agent({}, [])).sessions.find((s) => s.id === SES)!.input_b64).toBe("");
  });

  it("output chunks are framed per line and acknowledged by character count", async () => {
    await agent({}, [{ session_id: SES, b64: "SGk=" }, { session_id: SES, b64: "Cg==" }]); // "Hi", "\n"
    const first = await client(0, null);
    expect(first.r_output).toBe("SGk=\nCg==\n");
    const parts = (first.r_output as string).split("\n").filter(Boolean).map((p) => Buffer.from(p, "base64").toString());
    expect(parts.join("")).toBe("Hi\n");
    // acknowledging what was received returns only newer output
    const ack = (first.r_output as string).length;
    await agent({}, [{ session_id: SES, b64: "IQ==" }]);
    expect((await client(ack, null)).r_output).toBe("IQ==\n");
    expect((await client(ack + 5, null)).r_output).toBe("");
  });

  it("output beyond the cap drops whole chunks from the front", async () => {
    const big = "A".repeat(400_000);
    await agent({}, [{ session_id: SES, b64: big }, { session_id: SES, b64: big }, { session_id: SES, b64: big }]);
    const buf = (await svc(`SELECT output_buffer AS b FROM public.terminal_sessions WHERE id='${SES}'`)).rows[0].b as string;
    expect(buf.length).toBeLessThanOrEqual(1_000_000);
    expect(buf.endsWith("\n")).toBe(true);
    expect(buf.split("\n").filter(Boolean).every((p) => p === big)).toBe(true); // no partial chunks
  });

  it("only the owner's session can be polled, and only an agent's own sessions are touched", async () => {
    const wrong = (await svc(`SELECT * FROM public.terminal_client_poll('${SES}','${A_USER}',0,'QQ==',NULL,NULL,false)`)).rows[0];
    expect(wrong.r_found).toBe(false);
    // an agent for ANOTHER server can neither read nor modify this session
    const r = (await svc(`SELECT public.terminal_agent_poll('${OTHER}','{"${SES}":999}'::jsonb,'[{"session_id":"${SES}","b64":"ZGVmYWNl"}]'::jsonb) AS r`)).rows[0].r as { sessions: unknown[] };
    expect(r.sessions).toEqual([]);
    const buf = (await svc(`SELECT output_buffer FROM public.terminal_sessions WHERE id='${SES}'`)).rows[0].output_buffer as string;
    expect(buf).not.toContain("ZGVmYWNl");
  });

  it("closing from the browser is reported to the agent so it can kill the shell", async () => {
    const r = await client(0, null, true);
    expect(r.r_status).toBe("closed");
    const agentView = await agent({}, []);
    expect(agentView.sessions.find((s) => s.id === SES)!.status).toBe("closed");
    expect(agentView.closed).toContain(SES);
    // further input to a closed session is ignored
    await client(0, "QQ==");
    expect((await svc(`SELECT input_buffer FROM public.terminal_sessions WHERE id='${SES}'`)).rows[0].input_buffer).toBe("");
  });

  it("resizing from the browser is applied", async () => {
    const r = await svc(`INSERT INTO public.terminal_sessions (id,server_id,user_id) VALUES ('a3000000-0000-0000-0000-000000000002','${SRV}','${U}') RETURNING id`);
    const res = (await svc(`SELECT * FROM public.terminal_client_poll('a3000000-0000-0000-0000-000000000002','${U}',0,NULL,132,NULL,false)`)).rows[0];
    expect(r.rows).toHaveLength(1);
    expect(res.r_cols).toBe(132);
  });
});
const A_USER = "a0000000-0000-0000-0000-0000000000ff";

describe("terminal_agent_poll_by_hash (auth + poll in one call)", () => {
  let db: PGlite;
  const U2 = "b0000000-0000-0000-0000-000000000001";
  const W2x = "b1000000-0000-0000-0000-000000000001";
  const S2 = "b2000000-0000-0000-0000-000000000001";
  const T2 = "b3000000-0000-0000-0000-000000000001";
  const svc = async (sql: string) => {
    await db.exec("SET ROLE service_role");
    try { return await db.query<Record<string, unknown>>(sql); } finally { await db.exec("RESET ROLE"); }
  };

  beforeAll(async () => {
    db = await boot(false);
    await db.exec(`
      INSERT INTO auth.users (id,email) VALUES ('${U2}','z@t.dev');
      SET ROLE service_role;
      INSERT INTO public.workspaces (id,name,created_by) VALUES ('${W2x}','W','${U2}');
      INSERT INTO public.workspace_members (workspace_id,user_id,role) VALUES ('${W2x}','${U2}','owner');
      INSERT INTO public.servers (id,user_id,workspace_id,name,agent_token_hash) VALUES ('${S2}','${U2}','${W2x}','s','hash-good');
      INSERT INTO public.terminal_sessions (id,server_id,user_id,input_buffer) VALUES ('${T2}','${S2}','${U2}','QQ==' || E'\n');
      RESET ROLE;`);
  }, 120_000);
  afterAll(async () => { await db?.close(); });

  it("a valid token hash polls the right server's sessions", async () => {
    const r = (await svc(`SELECT public.terminal_agent_poll_by_hash('hash-good','{}'::jsonb,'[]'::jsonb) AS r`)).rows[0].r as { sessions: { id: string; input_b64: string }[] };
    expect(r.sessions.map((s) => s.id)).toEqual([T2]);
    expect(r.sessions[0].input_b64).toBe("QQ==\n");
  });

  it("an unknown token hash returns NULL and touches nothing", async () => {
    expect((await svc(`SELECT public.terminal_agent_poll_by_hash('hash-bad','{}'::jsonb,'[]'::jsonb) AS r`)).rows[0].r).toBeNull();
    expect((await svc(`SELECT public.terminal_agent_poll_by_hash('','{}'::jsonb,'[]'::jsonb) AS r`)).rows[0].r).toBeNull();
  });

  it("is not callable from the browser or signed-out users", async () => {
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`SET ROLE ${role}`);
      await expect(db.query(`SELECT public.terminal_agent_poll_by_hash('hash-good','{}'::jsonb,'[]'::jsonb)`)).rejects.toThrow(DENIED);
      await db.exec(`RESET ROLE`);
    }
  });
});
