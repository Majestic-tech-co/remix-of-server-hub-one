// Scheduled playbooks, tested on a real Postgres engine with every migration applied.
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { boot, DENIED } from "./harness";

const ADM = "a0000000-0000-0000-0000-000000000001"; // admin of W (creates schedules)
const ADM2 = "a0000000-0000-0000-0000-000000000005"; // second admin of W
const OWN = "a0000000-0000-0000-0000-000000000002"; // owner of W
const MEM = "a0000000-0000-0000-0000-000000000003"; // member of W
const VIE = "a0000000-0000-0000-0000-000000000004"; // viewer of W
const OTH = "a0000000-0000-0000-0000-000000000006"; // owner of a different team
const W = "b1000000-0000-0000-0000-000000000001";
const WO = "b1000000-0000-0000-0000-000000000002";
const S_ON = "b2000000-0000-0000-0000-000000000001";   // online
const S_ON2 = "b2000000-0000-0000-0000-000000000002"; // online
const S_OFF = "b2000000-0000-0000-0000-000000000003"; // offline for an hour
const S_MON = "b2000000-0000-0000-0000-000000000004"; // monitoring-only
const S_OTHER = "b2000000-0000-0000-0000-000000000005"; // belongs to the other team
const T = "b3000000-0000-0000-0000-000000000001";      // playbook in W
const T_OTHER = "b3000000-0000-0000-0000-000000000002"; // playbook in the other team

describe("scheduled playbooks", () => {
  let db: PGlite;

  const as = async (uid: string, sql: string) => {
    await db.exec(`SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub','${uid}',false), set_config('request.jwt.claims','{}',false);`);
    try { return await db.query<Record<string, unknown>>(sql); }
    finally { await db.exec("RESET ROLE; SELECT set_config('request.jwt.claim.sub', '', false)"); }
  };
  const svc = async (sql: string) => {
    await db.exec("SET ROLE service_role");
    try { return await db.query<Record<string, unknown>>(sql); } finally { await db.exec("RESET ROLE"); }
  };
  const admin = (sql: string) => db.query<Record<string, unknown>>(sql);
  const next = async (freq: string, tod: string, dow: number | null, dom: number | null, tz: string, after: string) =>
    ((await admin(`SELECT public.compute_next_run('${freq}','${tod}',${dow ?? "NULL"},${dom ?? "NULL"},'${tz}','${after}') AS n`)).rows[0].n as Date).toISOString();

  /** create a schedule as an admin; returns its id */
  let seq = 0;
  async function createSchedule(over: Record<string, string> = {}, as_ = ADM) {
    const f: Record<string, string> = {
      workspace_id: `'${W}'`, task_id: `'${T}'`, name: `'sched ${++seq}'`, all_servers: "true", server_ids: "'{}'::uuid[]",
      frequency: "'daily'", time_of_day: "'03:00'", timezone: "'UTC'", created_by: `'${as_}'`, ...over,
    };
    const r = await as(as_, `INSERT INTO public.playbook_schedules (${Object.keys(f).join(",")}) VALUES (${Object.values(f).join(",")}) RETURNING id`);
    return r.rows[0].id as string;
  }
  const sched = async (id: string) =>
    (await svc(`SELECT * FROM public.playbook_schedules WHERE id='${id}'`)).rows[0] as Record<string, any>;
  const makeDue = (id: string, ago = "1 minute") => svc(`UPDATE public.playbook_schedules SET next_run_at = now() - interval '${ago}' WHERE id='${id}'`);
  const runDue = async () => (await admin(`SELECT public.run_due_schedules() AS n`)).rows[0].n as number;
  const auditActions = async (uid: string, action: string) =>
    (await as(uid, `SELECT detail FROM public.audit_log WHERE action='${action}' ORDER BY id`)).rows.map((r) => r.detail as Record<string, any>);

  beforeAll(async () => {
    db = await boot(false);
    await db.exec(`
      INSERT INTO auth.users (id,email) VALUES ('${ADM}','a@t.dev'),('${ADM2}','a2@t.dev'),('${OWN}','o@t.dev'),('${MEM}','m@t.dev'),('${VIE}','v@t.dev'),('${OTH}','x@t.dev');
      SET ROLE service_role;
      INSERT INTO public.workspaces (id,name,created_by) VALUES ('${W}','W','${OWN}'),('${WO}','Other','${OTH}');
      INSERT INTO public.workspace_members (workspace_id,user_id,role) VALUES
        ('${W}','${OWN}','owner'),('${W}','${ADM}','admin'),('${W}','${ADM2}','admin'),('${W}','${MEM}','member'),('${W}','${VIE}','viewer'),('${WO}','${OTH}','owner');
      INSERT INTO public.servers (id,user_id,workspace_id,name,agent_token_hash,last_seen_at,remote_access) VALUES
        ('${S_ON}','${OWN}','${W}','a-online','h1', now(), true),
        ('${S_ON2}','${OWN}','${W}','b-online','h2', now(), true),
        ('${S_OFF}','${OWN}','${W}','c-offline','h3', now() - interval '1 hour', true),
        ('${S_MON}','${OWN}','${W}','d-monitoring','h4', now(), false),
        ('${S_OTHER}','${OTH}','${WO}','other','h5', now(), true);
      INSERT INTO public.automation_tasks (id,user_id,workspace_id,name,script_content) VALUES
        ('${T}','${ADM}','${W}','weekly update','apt-get update && apt-get -y upgrade'),
        ('${T_OTHER}','${OTH}','${WO}','theirs','echo other');
      RESET ROLE;`);
  }, 120_000);
  afterAll(async () => { await db?.close(); });

  // ───────────── the clock ─────────────
  describe("when is the next run?", () => {
    it("daily: strictly after the given moment", async () => {
      expect(await next("daily", "03:00", null, null, "UTC", "2026-11-12T10:00:00Z")).toBe("2026-11-13T03:00:00.000Z");
      expect(await next("daily", "03:00", null, null, "UTC", "2026-11-12T02:00:00Z")).toBe("2026-11-12T03:00:00.000Z");
      expect(await next("daily", "03:00", null, null, "UTC", "2026-11-12T03:00:00Z")).toBe("2026-11-13T03:00:00.000Z"); // not "now"
    });
    it("weekly: the right weekday (0 = Sunday)", async () => {
      // 2026-11-12 is a Thursday
      expect(await next("weekly", "03:00", 0, null, "UTC", "2026-11-12T10:00:00Z")).toBe("2026-11-15T03:00:00.000Z"); // Sunday
      expect(await next("weekly", "03:00", 4, null, "UTC", "2026-11-12T10:00:00Z")).toBe("2026-11-19T03:00:00.000Z"); // same day passed -> next Thursday
      expect(await next("weekly", "12:00", 4, null, "UTC", "2026-11-12T10:00:00Z")).toBe("2026-11-12T12:00:00.000Z"); // later today
    });
    it("monthly: this month if still ahead, otherwise next month, across year end", async () => {
      expect(await next("monthly", "03:00", null, 15, "UTC", "2026-11-10T00:00:00Z")).toBe("2026-11-15T03:00:00.000Z");
      expect(await next("monthly", "03:00", null, 15, "UTC", "2026-11-20T00:00:00Z")).toBe("2026-12-15T03:00:00.000Z");
      expect(await next("monthly", "03:00", null, 1, "UTC", "2026-12-20T00:00:00Z")).toBe("2027-01-01T03:00:00.000Z");
      expect(await next("monthly", "03:00", null, 28, "UTC", "2027-02-01T00:00:00Z")).toBe("2027-02-28T03:00:00.000Z");
    });
    it("honours the time zone, including daylight saving", async () => {
      expect(await next("daily", "03:00", null, null, "America/New_York", "2026-07-01T00:00:00Z")).toBe("2026-07-01T07:00:00.000Z"); // EDT = UTC-4
      expect(await next("daily", "03:00", null, null, "America/New_York", "2026-12-01T00:00:00Z")).toBe("2026-12-01T08:00:00.000Z"); // EST = UTC-5
      expect(await next("daily", "09:00", null, null, "Australia/Sydney", "2026-11-12T00:00:00Z")).toBe("2026-11-12T22:00:00.000Z"); // AEDT = UTC+11 (9am on the 13th)
    });
    it("spring-forward: a time that doesn't exist still happens exactly once that day", async () => {
      const first = await next("daily", "02:30", null, null, "America/New_York", "2026-03-07T12:00:00Z");
      expect(first.startsWith("2026-03-08")).toBe(true);                     // on the gap day
      const second = await next("daily", "02:30", null, null, "America/New_York", first);
      expect(second).toBe("2026-03-09T06:30:00.000Z");                       // next day, normal EDT
    });
    it("fall-back: an ambiguous time happens once, not twice", async () => {
      const first = await next("daily", "01:30", null, null, "America/New_York", "2026-10-31T12:00:00Z");
      expect(first.startsWith("2026-11-01")).toBe(true);
      const second = await next("daily", "01:30", null, null, "America/New_York", first);
      expect(second.startsWith("2026-11-02")).toBe(true);                    // not a second run on the 1st
    });
    it("rejects an unknown time zone", async () => {
      await expect(createSchedule({ timezone: "'Mars/Olympus'" })).rejects.toThrow(/time zone|violates/i);
    });
  });

  // ───────────── who can do what ─────────────
  describe("access and validation", () => {
    it("an admin creates a schedule: next run is computed, it is attributed to them and audited", async () => {
      const id = await createSchedule({ name: "'nightly'" });
      const s = await sched(id);
      expect(s.created_by).toBe(ADM);
      expect(s.enabled).toBe(true);
      expect(new Date(s.next_run_at).getTime()).toBeGreaterThan(Date.now());
      const created = (await auditActions(OWN, "schedule.created")).filter((d) => d.name === "nightly");
      expect(created).toHaveLength(1);
      expect(created[0].frequency).toBe("daily");
    });

    it("members can see schedules but not create, change or delete them; viewers and other teams see nothing", async () => {
      const id = await createSchedule();
      expect((await as(MEM, `SELECT id FROM public.playbook_schedules WHERE id='${id}'`)).rows).toHaveLength(1);
      expect((await as(VIE, `SELECT id FROM public.playbook_schedules`)).rows).toHaveLength(0);
      expect((await as(OTH, `SELECT id FROM public.playbook_schedules`)).rows).toHaveLength(0);
      await expect(createSchedule({}, MEM)).rejects.toThrow(DENIED);
      expect((await as(MEM, `UPDATE public.playbook_schedules SET enabled=false WHERE id='${id}' RETURNING id`)).rows).toHaveLength(0);
      expect((await as(MEM, `DELETE FROM public.playbook_schedules WHERE id='${id}' RETURNING id`)).rows).toHaveLength(0);
      expect((await as(OTH, `DELETE FROM public.playbook_schedules WHERE id='${id}' RETURNING id`)).rows).toHaveLength(0);
      expect((await sched(id))).toBeTruthy();
    });

    it("the browser can never set system-managed fields or impersonate another creator", async () => {
      const id = await createSchedule();
      await expect(as(ADM, `UPDATE public.playbook_schedules SET next_run_at = now() WHERE id='${id}'`)).rejects.toThrow(DENIED);
      await expect(as(ADM, `UPDATE public.playbook_schedules SET last_result = 'ok' WHERE id='${id}'`)).rejects.toThrow(DENIED);
      await expect(as(ADM, `UPDATE public.playbook_schedules SET workspace_id = '${WO}' WHERE id='${id}'`)).rejects.toThrow(DENIED);
      await expect(createSchedule({ created_by: `'${OWN}'` })).rejects.toThrow(DENIED); // can't create "as" someone else
    });

    it("rejects playbooks or servers from another team, and malformed schedules", async () => {
      await expect(createSchedule({ task_id: `'${T_OTHER}'` })).rejects.toThrow(/not found|violates/i);
      await expect(createSchedule({ all_servers: "false", server_ids: `ARRAY['${S_OTHER}']::uuid[]` })).rejects.toThrow(/not found|violates/i);
      await expect(createSchedule({ all_servers: "false", server_ids: "'{}'::uuid[]" })).rejects.toThrow(DENIED);     // no targets
      await expect(createSchedule({ all_servers: "true", server_ids: `ARRAY['${S_ON}']::uuid[]` })).rejects.toThrow(DENIED); // both
      await expect(createSchedule({ frequency: "'weekly'" })).rejects.toThrow(DENIED);                               // no weekday
      await expect(createSchedule({ frequency: "'monthly'", day_of_month: "29" })).rejects.toThrow(DENIED);          // no 29th-31st
      await expect(createSchedule({ frequency: "'hourly'" })).rejects.toThrow(DENIED);
    });

    it("clears fields that don't apply and removes duplicate targets", async () => {
      const id = await createSchedule({ frequency: "'daily'", day_of_week: "3", day_of_month: "10", all_servers: "false", server_ids: `ARRAY['${S_ON}','${S_ON}','${S_ON2}']::uuid[]` });
      const s = await sched(id);
      expect(s.day_of_week).toBeNull();
      expect(s.day_of_month).toBeNull();
      expect(s.server_ids).toHaveLength(2);
    });

    it("another admin changing a schedule takes over responsibility for it; disabling/enabling recomputes the next run", async () => {
      const id = await createSchedule();
      await as(ADM2, `UPDATE public.playbook_schedules SET enabled=false WHERE id='${id}'`);
      let s = await sched(id);
      expect(s.created_by).toBe(ADM2);
      expect(s.next_run_at).toBeNull();
      await as(ADM2, `UPDATE public.playbook_schedules SET enabled=true, time_of_day='04:30' WHERE id='${id}'`);
      s = await sched(id);
      expect(new Date(s.next_run_at).getTime()).toBeGreaterThan(Date.now());
      expect(new Date(s.next_run_at).toISOString().slice(11, 16)).toBe("04:30");
      expect((await auditActions(OWN, "schedule.updated")).length).toBeGreaterThanOrEqual(2);
    });

    it("deleting a schedule is audited; deleting the playbook removes its schedules", async () => {
      const id = await createSchedule({ name: "'to delete'" });
      await as(ADM, `DELETE FROM public.playbook_schedules WHERE id='${id}'`);
      expect((await auditActions(OWN, "schedule.deleted")).some((d) => d.name === "to delete")).toBe(true);
      await svc(`INSERT INTO public.automation_tasks (id,user_id,workspace_id,name,script_content) VALUES ('b3000000-0000-0000-0000-0000000000f1','${ADM}','${W}','temp','echo')`);
      const id2 = await createSchedule({ task_id: "'b3000000-0000-0000-0000-0000000000f1'" });
      await svc(`DELETE FROM public.automation_tasks WHERE id='b3000000-0000-0000-0000-0000000000f1'`);
      expect(await sched(id2)).toBeUndefined();
    });

    it("limits schedules per team", async () => {
      const before = Number((await svc(`SELECT count(*)::int AS n FROM public.playbook_schedules WHERE workspace_id='${W}'`)).rows[0].n);
      for (let i = before; i < 50; i++) await createSchedule();
      await expect(createSchedule()).rejects.toThrow(/limit|violates/i);
      await svc(`DELETE FROM public.playbook_schedules WHERE workspace_id='${W}'`); // reset for the engine tests
    });

    it("playbook creation, edits and deletion are audited (editing changes what schedules run)", async () => {
      await as(ADM, `INSERT INTO public.automation_tasks (id,user_id,workspace_id,name,script_content) VALUES ('b3000000-0000-0000-0000-0000000000f2','${ADM}','${W}','audited','echo 1')`);
      await as(ADM, `UPDATE public.automation_tasks SET script_content='echo 2' WHERE id='b3000000-0000-0000-0000-0000000000f2'`);
      await as(ADM, `UPDATE public.automation_tasks SET name='audited 2' WHERE id='b3000000-0000-0000-0000-0000000000f2'`);
      await as(ADM, `DELETE FROM public.automation_tasks WHERE id='b3000000-0000-0000-0000-0000000000f2'`);
      expect((await auditActions(OWN, "playbook.created")).some((d) => d.name === "audited")).toBe(true);
      const updates = (await auditActions(OWN, "playbook.updated")).filter((d) => String(d.name).startsWith("audited"));
      expect(updates.map((d) => d.script_changed)).toEqual([true, false]);
      expect((await auditActions(OWN, "playbook.deleted")).some((d) => d.name === "audited 2")).toBe(true);
    });
  });

  // ───────────── the engine ─────────────
  describe("running due schedules", () => {
    it("starts a run on online servers, skips offline and monitoring-only ones with a reason, and records it", async () => {
      const id = await createSchedule({ name: "'engine-1'" });
      await makeDue(id);
      expect(await runDue()).toBe(1);

      const s = await sched(id);
      expect(new Date(s.next_run_at).getTime()).toBeGreaterThan(Date.now());   // moved to the future
      expect(s.last_result).toBe("started on 2, skipped 2");
      const run = (await svc(`SELECT status, target_count, user_id FROM public.automation_runs WHERE id='${s.last_run_id}'`)).rows[0];
      expect(run).toEqual({ status: "running", target_count: 4, user_id: ADM });

      const cmds = (await svc(`SELECT c.server_id, c.command, c.user_id, c.status FROM public.commands c JOIN public.task_logs l ON l.command_id = c.id WHERE l.run_id='${s.last_run_id}' ORDER BY c.server_id`)).rows;
      expect(cmds.map((c) => c.server_id)).toEqual([S_ON, S_ON2]);
      expect(cmds.every((c) => c.command === "apt-get update && apt-get -y upgrade" && c.user_id === ADM && c.status === "pending")).toBe(true);

      const skipped = (await svc(`SELECT server_id, status, output_log FROM public.task_logs WHERE run_id='${s.last_run_id}' AND command_id IS NULL ORDER BY server_id`)).rows;
      expect(skipped.map((r) => r.server_id)).toEqual([S_OFF, S_MON]);
      expect(String(skipped[0].output_log)).toContain("offline");
      expect(String(skipped[1].output_log)).toContain("monitoring-only");

      const ran = (await auditActions(OWN, "schedule.ran")).filter((d) => d.name === "engine-1");
      expect(ran).toEqual([{ name: "engine-1", started: 2, skipped: 2, run_id: s.last_run_id }]);
      // the commands are audited like any other command (as the person the schedule runs as)
      expect((await auditActions(OWN, "command.queued")).filter((d) => d.command === "apt-get update && apt-get -y upgrade").length).toBeGreaterThanOrEqual(2);
    });

    it("the run finishes when its commands do, and counts a skipped server as a failure", async () => {
      const id = await createSchedule({ name: "'engine-2'" });
      await makeDue(id);
      await runDue();
      const runId = (await sched(id)).last_run_id;
      const cmdIds = (await svc(`SELECT command_id FROM public.task_logs WHERE run_id='${runId}' AND command_id IS NOT NULL`)).rows.map((r) => r.command_id);
      for (const c of cmdIds) await svc(`UPDATE public.commands SET status='completed', exit_code=0 WHERE id='${c}'`);
      expect((await svc(`SELECT status FROM public.automation_runs WHERE id='${runId}'`)).rows).toEqual([{ status: "failed" }]); // offline/monitoring targets were skipped
    });

    it("selected servers only; a fully healthy selection succeeds", async () => {
      const id = await createSchedule({ all_servers: "false", server_ids: `ARRAY['${S_ON}','${S_ON2}']::uuid[]` });
      await makeDue(id);
      await runDue();
      const s = await sched(id);
      expect(s.last_result).toBe("started on 2 servers");
      const cmdIds = (await svc(`SELECT command_id FROM public.task_logs WHERE run_id='${s.last_run_id}'`)).rows.map((r) => r.command_id);
      for (const c of cmdIds) await svc(`UPDATE public.commands SET status='completed', exit_code=0 WHERE id='${c}'`);
      expect((await svc(`SELECT status FROM public.automation_runs WHERE id='${s.last_run_id}'`)).rows).toEqual([{ status: "success" }]);
    });

    it("when every server is skipped the run is over immediately", async () => {
      const id = await createSchedule({ all_servers: "false", server_ids: `ARRAY['${S_OFF}','${S_MON}']::uuid[]` });
      await makeDue(id);
      await runDue();
      const s = await sched(id);
      expect(s.last_result).toContain("nothing started");
      expect((await svc(`SELECT status, finished_at IS NOT NULL AS done FROM public.automation_runs WHERE id='${s.last_run_id}'`)).rows).toEqual([{ status: "failed", done: true }]);
      expect((await svc(`SELECT count(*)::int AS n FROM public.commands c JOIN public.task_logs l ON l.command_id=c.id WHERE l.run_id='${s.last_run_id}'`)).rows).toEqual([{ n: 0 }]);
    });

    it("does not run schedules that are not due, or are disabled", async () => {
      const future = await createSchedule({ name: "'future'" });
      const off = await createSchedule({ name: "'off'", enabled: "false" });
      expect(await runDue()).toBe(0);
      await svc(`UPDATE public.playbook_schedules SET next_run_at = now() - interval '1 minute' WHERE id='${off}'`); // even if its time is "due"
      expect(await runDue()).toBe(0);
      expect((await sched(future)).last_run_at).toBeNull();
      expect((await sched(off)).last_run_at).toBeNull();
    });

    it("never runs the same occurrence twice", async () => {
      const id = await createSchedule({ all_servers: "false", server_ids: `ARRAY['${S_ON}']::uuid[]` });
      await makeDue(id);
      expect(await runDue()).toBe(1);
      expect(await runDue()).toBe(0);
      expect((await svc(`SELECT count(*)::int AS n FROM public.automation_runs WHERE id IN (SELECT last_run_id FROM public.playbook_schedules WHERE id='${id}')`)).rows).toEqual([{ n: 1 }]);
    });

    it("skips an occurrence missed by more than 2 hours (system was down) instead of running late", async () => {
      const id = await createSchedule({ all_servers: "false", server_ids: `ARRAY['${S_ON}']::uuid[]` });
      await makeDue(id, "5 hours");
      await runDue();
      const s = await sched(id);
      expect(s.last_result).toContain("missed");
      expect(s.last_run_id).toBeNull();
      expect(new Date(s.next_run_at).getTime()).toBeGreaterThan(Date.now());
      // 90 minutes late is still inside the window
      await makeDue(id, "90 minutes");
      expect(await runDue()).toBe(1);
    });

    it("does not start a new run while the previous one is still going", async () => {
      const id = await createSchedule({ all_servers: "false", server_ids: `ARRAY['${S_ON}']::uuid[]` });
      await makeDue(id);
      await runDue();
      const first = (await sched(id)).last_run_id;
      await makeDue(id);
      expect(await runDue()).toBe(0);
      let s = await sched(id);
      expect(s.last_result).toContain("still in progress");
      expect(s.last_run_id).toBe(first);
      // once the first run has finished, the next occurrence runs normally
      await svc(`UPDATE public.automation_runs SET status='success', finished_at=now() WHERE id='${first}'`);
      await makeDue(id);
      expect(await runDue()).toBe(1);
      s = await sched(id);
      expect(s.last_run_id).not.toBe(first);
    });

    it("disables itself if the person it runs as lost admin access, and runs nothing", async () => {
      const id = await createSchedule({ all_servers: "false", server_ids: `ARRAY['${S_ON}']::uuid[]` }, ADM2);
      await svc(`UPDATE public.workspace_members SET role='member' WHERE workspace_id='${W}' AND user_id='${ADM2}'`);
      await makeDue(id);
      expect(await runDue()).toBe(0);
      const s = await sched(id);
      expect(s.enabled).toBe(false);
      expect(s.next_run_at).toBeNull();
      expect(s.last_result).toContain("no longer has admin access");
      expect(s.last_run_id).toBeNull();
      expect((await auditActions(OWN, "schedule.disabled")).length).toBeGreaterThanOrEqual(1);
      await svc(`UPDATE public.workspace_members SET role='admin' WHERE workspace_id='${W}' AND user_id='${ADM2}'`);
    });

    it("runs the CURRENT version of the playbook", async () => {
      const id = await createSchedule({ all_servers: "false", server_ids: `ARRAY['${S_ON}']::uuid[]` });
      await svc(`UPDATE public.automation_tasks SET script_content='echo updated-script' WHERE id='${T}'`);
      await makeDue(id);
      await runDue();
      const s = await sched(id);
      const cmd = (await svc(`SELECT c.command FROM public.commands c JOIN public.task_logs l ON l.command_id=c.id WHERE l.run_id='${s.last_run_id}'`)).rows[0].command;
      expect(cmd).toBe("echo updated-script");
      await svc(`UPDATE public.automation_tasks SET script_content='apt-get update && apt-get -y upgrade' WHERE id='${T}'`);
    });

    it("one broken schedule can't stop the others", async () => {
      await svc(`INSERT INTO public.automation_tasks (id,user_id,workspace_id,name,script_content) VALUES ('b3000000-0000-0000-0000-0000000000f3','${ADM}','${W}','boom','BOOM')`);
      await db.exec(`CREATE OR REPLACE FUNCTION public.test_boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.command = 'BOOM' THEN RAISE EXCEPTION 'simulated failure'; END IF; RETURN NEW; END $$;
                     CREATE TRIGGER test_boom_trg BEFORE INSERT ON public.commands FOR EACH ROW EXECUTE FUNCTION public.test_boom();`);
      const bad = await createSchedule({ task_id: "'b3000000-0000-0000-0000-0000000000f3'", all_servers: "false", server_ids: `ARRAY['${S_ON}']::uuid[]` });
      const good = await createSchedule({ all_servers: "false", server_ids: `ARRAY['${S_ON2}']::uuid[]` });
      await makeDue(bad, "2 minutes");
      await makeDue(good, "1 minute");
      expect(await runDue()).toBe(1);
      expect((await sched(bad)).last_result).toContain("error");
      expect(new Date((await sched(bad)).next_run_at).getTime()).toBeGreaterThan(Date.now()); // will try again next time, not loop now
      expect((await sched(good)).last_run_id).not.toBeNull();
      // the failed attempt left no half-made run behind
      expect((await svc(`SELECT count(*)::int AS n FROM public.automation_runs r WHERE r.task_id='b3000000-0000-0000-0000-0000000000f3'`)).rows).toEqual([{ n: 0 }]);
      await db.exec(`DROP TRIGGER test_boom_trg ON public.commands; DROP FUNCTION public.test_boom();`);
    });

    it("the engine and its helpers are not callable from the browser", async () => {
      await expect(as(ADM, `SELECT public.run_due_schedules()`)).rejects.toThrow(DENIED);
      await expect(as(ADM, `SELECT public.rollup_run_from_command()`)).rejects.toThrow(DENIED);
      await db.exec("SET ROLE anon");
      await expect(db.query(`SELECT public.run_due_schedules()`)).rejects.toThrow(DENIED);
      await db.exec("RESET ROLE");
    });

    it("deleting a team removes its schedules cleanly", async () => {
      await svc(`INSERT INTO public.workspaces (id,name,created_by) VALUES ('b1000000-0000-0000-0000-0000000000aa','Temp','${OTH}')`);
      await svc(`INSERT INTO public.workspace_members (workspace_id,user_id,role) VALUES ('b1000000-0000-0000-0000-0000000000aa','${OTH}','owner')`);
      await svc(`INSERT INTO public.automation_tasks (id,user_id,workspace_id,name,script_content) VALUES ('b3000000-0000-0000-0000-0000000000f4','${OTH}','b1000000-0000-0000-0000-0000000000aa','t','echo')`);
      await svc(`INSERT INTO public.playbook_schedules (workspace_id,task_id,name,all_servers,frequency,created_by) VALUES ('b1000000-0000-0000-0000-0000000000aa','b3000000-0000-0000-0000-0000000000f4','s',true,'daily','${OTH}')`);
      await admin(`DELETE FROM public.workspaces WHERE id='b1000000-0000-0000-0000-0000000000aa'`);
      expect((await svc(`SELECT count(*)::int AS n FROM public.playbook_schedules WHERE workspace_id='b1000000-0000-0000-0000-0000000000aa'`)).rows).toEqual([{ n: 0 }]);
    });
  });
});
