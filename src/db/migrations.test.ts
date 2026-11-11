// Runs EVERY migration, in order, on a real Postgres engine (PGlite) with Supabase-style roles
// and a stub `auth` schema, then checks the security rules actually hold.
// Executed twice: with Supabase's "Automatically expose new tables" ON (worst case: every new
// table is granted to API roles) and OFF.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DIR = join(process.cwd(), "supabase", "migrations");
const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const SA = "a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1"; // A's server
const SB = "b1b1b1b1-b1b1-b1b1-b1b1-b1b1b1b1b1b1"; // B's server
const DENIED = /permission denied|row-level security|violates|row limit|does not exist/i;

async function boot(autoExpose: boolean): Promise<PGlite> {
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
  `);
  if (autoExpose) {
    await db.exec(`
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    `);
  }
  const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    try {
      await db.exec(readFileSync(join(DIR, f), "utf8"));
    } catch (e) {
      throw new Error(`migration ${f} failed: ${(e as Error).message}`);
    }
  }
  return db;
}

describe.each([
  { autoExpose: true, label: "auto-expose ON" },
  { autoExpose: false, label: "auto-expose OFF" },
])("migrations ($label)", ({ autoExpose }) => {
  let db: PGlite;

  const as = async (role: "anon" | "authenticated" | "service_role", uid: string | null, sql: string) => {
    await db.exec(`SET ROLE ${role}; SELECT set_config('request.jwt.claim.sub', '${uid ?? ""}', false);`);
    try {
      return await db.query<Record<string, unknown>>(sql);
    } finally {
      await db.exec("RESET ROLE");
    }
  };
  const admin = (sql: string) => db.query<Record<string, unknown>>(sql);
  // multi-statement seed as the service role
  const seed = async (sql: string) => { await db.exec(`SET ROLE service_role; ${sql}; RESET ROLE;`); };

  beforeAll(async () => {
    db = await boot(autoExpose);
    await admin(`INSERT INTO auth.users (id, email) VALUES ('${A}','a@test.dev'), ('${B}','b@test.dev')`);
    await as("service_role", null, `
      INSERT INTO public.servers (id, user_id, name, agent_token_hash, last_seen_at) VALUES
        ('${SA}','${A}','alpha','hash-a', now()),
        ('${SB}','${B}','bravo','hash-b', now())`);
  }, 120_000);
  afterAll(async () => { await db?.close(); });

  it("every public table has row-level security enabled", async () => {
    const r = await admin(`SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                           WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity`);
    expect(r.rows).toEqual([]);
  });

  it("signed-out (anon) users can read and write nothing", async () => {
    for (const t of ["servers", "metrics", "commands", "terminal_sessions", "automation_tasks",
                     "automation_runs", "task_logs", "cost_metrics", "audit_log", "alerts"]) {
      await expect(as("anon", null, `SELECT * FROM public.${t}`), t).rejects.toThrow(DENIED);
    }
    await expect(as("anon", null, `INSERT INTO public.commands (server_id,user_id,command) VALUES ('${SA}','${A}','x')`))
      .rejects.toThrow(DENIED);
  });

  it("users only see their own servers", async () => {
    const r = await as("authenticated", A, `SELECT id FROM public.servers`);
    expect(r.rows.map((x) => x.id)).toEqual([SA]);
  });

  it("the agent token hash is not readable from the browser", async () => {
    await expect(as("authenticated", A, `SELECT agent_token_hash FROM public.servers`)).rejects.toThrow(DENIED);
    await expect(as("authenticated", A, `SELECT * FROM public.servers`)).rejects.toThrow(DENIED);
    const ok = await as("authenticated", A, `SELECT id, name, connection_notes FROM public.servers`);
    expect(ok.rows).toHaveLength(1);
  });

  it("users cannot insert servers directly or tamper with token/owner", async () => {
    await expect(as("authenticated", A,
      `INSERT INTO public.servers (user_id,name,agent_token_hash) VALUES ('${A}','x','h')`)).rejects.toThrow(DENIED);
    await expect(as("authenticated", A, `UPDATE public.servers SET agent_token_hash='evil'`)).rejects.toThrow(DENIED);
    await expect(as("authenticated", A, `UPDATE public.servers SET user_id='${B}'`)).rejects.toThrow(DENIED);
  });

  it("users can edit their own server's notes but not another user's", async () => {
    const own = await as("authenticated", A, `UPDATE public.servers SET connection_notes='ssh me' WHERE id='${SA}' RETURNING id`);
    expect(own.rows).toHaveLength(1);
    const other = await as("authenticated", A, `UPDATE public.servers SET connection_notes='pwn' WHERE id='${SB}' RETURNING id`);
    expect(other.rows).toHaveLength(0);
  });

  it("commands: only on own servers; no updates; every insert is audited", async () => {
    await expect(as("authenticated", A,
      `INSERT INTO public.commands (server_id,user_id,command) VALUES ('${SB}','${A}','whoami')`)).rejects.toThrow(DENIED);
    await expect(as("authenticated", A,
      `INSERT INTO public.commands (server_id,user_id,command) VALUES ('${SA}','${B}','whoami')`)).rejects.toThrow(DENIED);

    await as("authenticated", A, `INSERT INTO public.commands (server_id,user_id,command) VALUES ('${SA}','${A}','uptime')`);
    await expect(as("authenticated", A, `UPDATE public.commands SET status='completed'`)).rejects.toThrow(DENIED);

    const mine = await as("authenticated", A, `SELECT action, detail->>'command' AS cmd FROM public.audit_log`);
    expect(mine.rows).toEqual([{ action: "command.queued", cmd: "uptime" }]);
    const theirs = await as("authenticated", B, `SELECT * FROM public.audit_log`);
    expect(theirs.rows).toHaveLength(0);
    await expect(as("authenticated", A, `DELETE FROM public.audit_log`)).rejects.toThrow(DENIED);
    await expect(as("authenticated", A, `INSERT INTO public.audit_log (user_id,action) VALUES ('${A}','x')`)).rejects.toThrow(DENIED);
  });

  it("metrics and terminal sessions have no browser write path", async () => {
    await expect(as("authenticated", A, `INSERT INTO public.metrics (server_id,cpu_percent) VALUES ('${SA}',1)`)).rejects.toThrow(DENIED);
    await expect(as("authenticated", A, `INSERT INTO public.terminal_sessions (server_id,user_id) VALUES ('${SA}','${A}')`)).rejects.toThrow(DENIED);
  });

  it("child rows cannot reference another user's parents", async () => {
    await seed(`
      INSERT INTO public.automation_tasks (id,user_id,name,script_content) VALUES ('11111111-1111-1111-1111-111111111111','${B}','t','echo');
      INSERT INTO public.automation_runs (id,user_id,task_id) VALUES ('22222222-2222-2222-2222-222222222222','${B}','11111111-1111-1111-1111-111111111111')`);
    await expect(as("authenticated", A,
      `INSERT INTO public.automation_runs (user_id,task_id) VALUES ('${A}','11111111-1111-1111-1111-111111111111')`)).rejects.toThrow(DENIED);
    await expect(as("authenticated", A,
      `INSERT INTO public.task_logs (user_id,run_id,server_id) VALUES ('${A}','22222222-2222-2222-2222-222222222222','${SA}')`)).rejects.toThrow(DENIED);
    await expect(as("authenticated", A,
      `INSERT INTO public.cost_metrics (user_id,server_id,day) VALUES ('${A}','${SB}', current_date)`)).rejects.toThrow(DENIED);
  });

  it("per-user row caps stop bulk inserts", async () => {
    await expect(as("authenticated", A,
      `INSERT INTO public.automation_tasks (user_id,name,script_content)
       SELECT '${A}','t'||g,'echo' FROM generate_series(1,501) g`)).rejects.toThrow(/row limit/i);
  });

  it("alerts: raised, de-duplicated, scoped, acknowledge-only, and auto-resolved", async () => {
    await as("service_role", null, `INSERT INTO public.metrics (server_id,cpu_percent,memory_percent,disk_percent) VALUES ('${SA}',95,10,10)`);
    await admin(`SELECT public.evaluate_alerts()`);
    await admin(`SELECT public.evaluate_alerts()`); // twice: must not duplicate
    const open = await as("authenticated", A, `SELECT kind, message FROM public.alerts WHERE resolved_at IS NULL`);
    expect(open.rows).toEqual([{ kind: "cpu", message: "alpha cpu usage is at 95%" }]);
    expect((await as("authenticated", B, `SELECT * FROM public.alerts`)).rows).toHaveLength(0);

    await as("authenticated", A, `UPDATE public.alerts SET acknowledged = true`);
    await expect(as("authenticated", A, `UPDATE public.alerts SET message = 'x'`)).rejects.toThrow(DENIED);
    await expect(as("authenticated", A, `DELETE FROM public.alerts`)).rejects.toThrow(DENIED);
    await expect(as("authenticated", A, `INSERT INTO public.alerts (user_id,server_id,kind,message) VALUES ('${A}','${SA}','disk','x')`)).rejects.toThrow(DENIED);

    await admin(`UPDATE public.metrics SET cpu_percent = 40`);
    await admin(`SELECT public.evaluate_alerts()`);
    const resolved = await as("authenticated", A, `SELECT resolved_at IS NOT NULL AS done FROM public.alerts WHERE kind='cpu'`);
    expect(resolved.rows).toEqual([{ done: true }]);

    // offline detection and recovery
    await admin(`UPDATE public.servers SET last_seen_at = now() - interval '10 minutes' WHERE id = '${SB}'`);
    await admin(`SELECT public.evaluate_alerts()`);
    expect((await as("authenticated", B, `SELECT kind FROM public.alerts WHERE resolved_at IS NULL`)).rows).toEqual([{ kind: "offline" }]);
    await admin(`UPDATE public.servers SET last_seen_at = now() WHERE id = '${SB}'`);
    await admin(`SELECT public.evaluate_alerts()`);
    expect((await as("authenticated", B, `SELECT kind FROM public.alerts WHERE resolved_at IS NULL`)).rows).toEqual([]);
  });

  it("maintenance functions are not callable from the API", async () => {
    await expect(as("authenticated", A, `SELECT public.purge_old_data()`)).rejects.toThrow(DENIED);
    await expect(as("anon", null, `SELECT public.evaluate_alerts()`)).rejects.toThrow(DENIED);
  });

  it("purge fails stuck commands and deletes old metrics", async () => {
    await admin(`INSERT INTO public.commands (id,server_id,user_id,command,status,started_at)
                 VALUES ('33333333-3333-3333-3333-333333333333','${SA}','${A}','sleep','running', now() - interval '3 hours')`);
    await admin(`INSERT INTO public.metrics (server_id,cpu_percent,recorded_at) VALUES ('${SA}',1, now() - interval '40 days')`);
    await admin(`SELECT public.purge_old_data()`);
    const c = await admin(`SELECT status FROM public.commands WHERE id='33333333-3333-3333-3333-333333333333'`);
    expect(c.rows).toEqual([{ status: "failed" }]);
    const old = await admin(`SELECT count(*)::int AS n FROM public.metrics WHERE recorded_at < now() - interval '30 days'`);
    expect(old.rows).toEqual([{ n: 0 }]);
  });

  it("deleting a user cascades without errors and logs no phantom server deletions", async () => {
    await admin(`DELETE FROM auth.users WHERE id = '${A}'`);
    expect((await admin(`SELECT count(*)::int AS n FROM public.servers WHERE user_id='${A}'`)).rows).toEqual([{ n: 0 }]);
    expect((await admin(`SELECT count(*)::int AS n FROM public.audit_log WHERE action='server.deleted' AND user_id='${A}'`)).rows).toEqual([{ n: 0 }]);
  });

  it("a user deleting their own server is audited", async () => {
    await as("authenticated", B, `DELETE FROM public.servers WHERE id='${SB}'`);
    const r = await as("authenticated", B, `SELECT action, detail->>'name' AS name FROM public.audit_log WHERE action='server.deleted'`);
    expect(r.rows).toEqual([{ action: "server.deleted", name: "bravo" }]);
  });
});
