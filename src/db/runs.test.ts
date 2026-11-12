// Playbook runs finish on their own: the database rolls a run up as soon as its commands finish,
// whether or not anyone has the run page open. (The page used to be the only thing that did this, and
// a stale-state bug there meant runs stayed "running" forever.)
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { boot, DENIED } from "./harness";

describe("playbook run completion", () => {
  let db: PGlite;
  const U = "e0000000-0000-0000-0000-000000000001";
  const WS = "e1000000-0000-0000-0000-000000000001";
  const S1 = "e2000000-0000-0000-0000-000000000001";
  const S2 = "e2000000-0000-0000-0000-000000000002";
  const T = "e3000000-0000-0000-0000-000000000001";
  let n = 0;
  const id = (p: string) => `${p}000000-0000-0000-0000-${String(++n).padStart(12, "0")}`;

  const svc = async (sql: string) => {
    await db.exec("SET ROLE service_role");
    try { return await db.query<Record<string, unknown>>(sql); } finally { await db.exec("RESET ROLE"); }
  };

  /** Start a run the way the app does: a run, then (per server) a command and a task_log. */
  async function startRun(servers: string[], opts: { target?: number | null; logsNow?: number } = {}) {
    const run = id("f1");
    const target = opts.target === undefined ? servers.length : opts.target;
    await svc(`INSERT INTO public.automation_runs (id,user_id,workspace_id,task_id,status,target_count)
               VALUES ('${run}','${U}','${WS}','${T}','running',${target ?? "NULL"})`);
    const cmds: string[] = [];
    const count = opts.logsNow ?? servers.length;
    for (const s of servers.slice(0, count)) cmds.push(await addTarget(run, s));
    return { run, cmds };
  }
  async function addTarget(run: string, server: string) {
    const c = id("f2");
    await svc(`INSERT INTO public.commands (id,server_id,user_id,command,status) VALUES ('${c}','${server}','${U}','apt-get update && apt-get -y upgrade','running')`);
    await svc(`INSERT INTO public.task_logs (user_id,run_id,server_id,command_id,status) VALUES ('${U}','${run}','${server}','${c}','pending')`);
    return c;
  }
  const finish = (cmd: string, status: "completed" | "failed", exit: number) =>
    svc(`UPDATE public.commands SET status='${status}', exit_code=${exit}, completed_at=now() WHERE id='${cmd}'`);
  const runRow = async (run: string) =>
    (await svc(`SELECT status, finished_at IS NOT NULL AS finished FROM public.automation_runs WHERE id='${run}'`)).rows[0];
  const logStatuses = async (run: string) =>
    (await svc(`SELECT status FROM public.task_logs WHERE run_id='${run}' ORDER BY created_at, id`)).rows.map((r) => r.status);

  beforeAll(async () => {
    db = await boot(false);
    await db.exec(`
      INSERT INTO auth.users (id,email) VALUES ('${U}','u@t.dev');
      SET ROLE service_role;
      INSERT INTO public.workspaces (id,name,created_by) VALUES ('${WS}','W','${U}');
      INSERT INTO public.workspace_members (workspace_id,user_id,role) VALUES ('${WS}','${U}','owner');
      INSERT INTO public.servers (id,user_id,workspace_id,name,agent_token_hash) VALUES
        ('${S1}','${U}','${WS}','one','h1'),('${S2}','${U}','${WS}','two','h2');
      INSERT INTO public.automation_tasks (id,user_id,workspace_id,name,script_content) VALUES ('${T}','${U}','${WS}','update','apt-get update');
      RESET ROLE;`);
  }, 120_000);
  afterAll(async () => { await db?.close(); });

  it("a successful single-server run finishes by itself", async () => {
    const { run, cmds } = await startRun([S1]);
    expect(await runRow(run)).toEqual({ status: "running", finished: false });
    await finish(cmds[0], "completed", 0);
    expect(await runRow(run)).toEqual({ status: "success", finished: true });
    expect(await logStatuses(run)).toEqual(["success"]);
  });

  it("a non-zero exit code fails the run", async () => {
    const { run, cmds } = await startRun([S1]);
    await finish(cmds[0], "completed", 100); // apt-get exits non-zero when something went wrong
    expect(await runRow(run)).toEqual({ status: "failed", finished: true });
    expect(await logStatuses(run)).toEqual(["failed"]);
  });

  it("a command that failed outright fails the run", async () => {
    const { run, cmds } = await startRun([S1]);
    await finish(cmds[0], "failed", -1);
    expect(await runRow(run)).toEqual({ status: "failed", finished: true });
  });

  it("a multi-server run waits for EVERY server, then reports failure if any failed", async () => {
    const { run, cmds } = await startRun([S1, S2]);
    await finish(cmds[0], "completed", 0);
    expect((await runRow(run)).status).toBe("running");          // second server not done yet
    expect(await logStatuses(run)).toEqual(["success", "pending"]);
    await finish(cmds[1], "completed", 1);
    expect(await runRow(run)).toEqual({ status: "failed", finished: true });
    expect(await logStatuses(run)).toEqual(["success", "failed"]);
  });

  it("all servers succeeding gives success", async () => {
    const { run, cmds } = await startRun([S1, S2]);
    await finish(cmds[1], "completed", 0);
    await finish(cmds[0], "completed", 0);
    expect(await runRow(run)).toEqual({ status: "success", finished: true });
  });

  it("a fast first result cannot close the run before the other servers' rows exist", async () => {
    // 2 targets, but only the first row has been created when its command finishes
    const { run, cmds } = await startRun([S1, S2], { logsNow: 1 });
    await finish(cmds[0], "completed", 0);
    expect((await runRow(run)).status).toBe("running");
    const second = await addTarget(run, S2);
    await finish(second, "completed", 0);
    expect(await runRow(run)).toEqual({ status: "success", finished: true });
  });

  it("runs started before target counts existed (NULL) still complete", async () => {
    const { run, cmds } = await startRun([S1], { target: null });
    await finish(cmds[0], "completed", 0);
    expect(await runRow(run)).toEqual({ status: "success", finished: true });
  });

  it("a finished run is never overwritten", async () => {
    const { run, cmds } = await startRun([S1]);
    await finish(cmds[0], "completed", 0);
    await svc(`UPDATE public.automation_runs SET status='failed' WHERE id='${run}'`); // e.g. set by hand
    await svc(`UPDATE public.commands SET stdout='late output' WHERE id='${cmds[0]}'`); // unrelated later update
    expect((await runRow(run)).status).toBe("failed");
  });

  it("commands cancelled by switching a server to monitoring-only close their run as failed", async () => {
    const run = id("f1");
    await svc(`INSERT INTO public.automation_runs (id,user_id,workspace_id,task_id,status,target_count) VALUES ('${run}','${U}','${WS}','${T}','running',1)`);
    const c = id("f2");
    await svc(`INSERT INTO public.commands (id,server_id,user_id,command,status) VALUES ('${c}','${S2}','${U}','date','pending')`);
    await svc(`INSERT INTO public.task_logs (user_id,run_id,server_id,command_id) VALUES ('${U}','${run}','${S2}','${c}')`);
    await svc(`UPDATE public.servers SET remote_access = false WHERE id='${S2}'`);
    expect(await runRow(run)).toEqual({ status: "failed", finished: true });
    await svc(`UPDATE public.servers SET remote_access = true WHERE id='${S2}'`);
  });

  it("a run whose command was lost is abandoned by the nightly cleanup, but a recent one is left alone", async () => {
    const old = id("f1");
    const fresh = id("f1");
    await svc(`INSERT INTO public.automation_runs (id,user_id,workspace_id,task_id,status,started_at) VALUES ('${old}','${U}','${WS}','${T}','running', now() - interval '2 days')`);
    await svc(`INSERT INTO public.automation_runs (id,user_id,workspace_id,task_id,status) VALUES ('${fresh}','${U}','${WS}','${T}','running')`);
    await db.query(`SELECT public.purge_old_data()`);
    expect((await runRow(old)).status).toBe("failed");
    expect((await runRow(fresh)).status).toBe("running");
  });

  it("the roll-up function is not callable from the browser", async () => {
    await db.exec("SET ROLE authenticated");
    await expect(db.query(`SELECT public.rollup_run_from_command()`)).rejects.toThrow(DENIED);
    await db.exec("RESET ROLE");
  });
});
