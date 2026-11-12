// Tests for: (1) secret redaction in the audit copy of commands, and (2) the per-server
// "remote access" (monitoring-only) switch. Run on a real Postgres engine with every migration applied.
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { boot, DENIED } from "./harness";

// ───────────── secret redaction ─────────────
describe("command redaction", () => {
  let db: PGlite;
  const redact = async (c: string) => (await db.query<{ r: string }>(`SELECT public.redact_command($1) AS r`, [c])).rows[0].r;

  beforeAll(async () => { db = await boot(false); }, 120_000);
  afterAll(async () => { await db?.close(); });

  it("scrubs passwords, tokens and keys but keeps the rest of the command readable", async () => {
    // [command, secrets that must be GONE, text that must REMAIN]
    const cases: [string, string[], string[]][] = [
      ["mysql -uroot -pSuperSecret123 appdb", ["SuperSecret123"], ["mysql", "-uroot", "appdb"]],
      ["mysqldump -h db -u admin -pHunter2! --all-databases", ["Hunter2!"], ["mysqldump", "--all-databases"]],
      ["export DB_PASSWORD='my pass phrase' && ./run.sh", ["my pass phrase"], ["export", "./run.sh"]],
      ["MYSQL_PWD=abc123 mysql -e 'select 1'", ["abc123"], ["mysql", "select 1"]],
      ["curl -H 'Authorization: Bearer abc.def.ghi' https://api.example.com/x", ["abc.def.ghi"], ["curl", "https://api.example.com/x"]],
      ["curl -u admin:hunter2 https://example.com", ["hunter2"], ["curl", "admin", "https://example.com"]],
      ["git clone https://deploy:s3cretpw@github.com/org/repo.git", ["s3cretpw"], ["git clone", "github.com/org/repo.git"]],
      ["aws configure set aws_access_key_id AKIAIOSFODNN7EXAMPLE", ["AKIAIOSFODNN7EXAMPLE"], ["aws configure"]],
      ["echo ghp_abcdefghijklmnopqrstuvwxyz0123456789 > t", ["ghp_abcdefghijklmnopqrstuvwxyz0123456789"], ["echo", "> t"]],
      ["sshpass -p s3cret ssh root@10.0.0.5", ["s3cret"], ["sshpass", "ssh root@10.0.0.5"]],
      ["tool --token abc123xyz --verbose", ["abc123xyz"], ["tool", "--verbose"]],
      ["tool --api-key=KEY12345 run", ["KEY12345"], ["tool", "run"]],
      ["printf '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----' > k", ["b3BlbnNzaC1rZXk"], [" > k"]],
      ["curl https://x.test -H 'x-api-key: abcd1234efgh'", ["abcd1234efgh"], ["curl", "https://x.test"]],
      ["echo eyJhbGciOiJIUzI1NiIsInR5cCI6IkpX.eyJzdWIiOiIxMjM0NTY3ODkw.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV", ["SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV"], ["echo"]],
    ];
    for (const [cmd, gone, kept] of cases) {
      const out = await redact(cmd);
      for (const s of gone) expect(out, `${cmd}  →  ${out}`).not.toContain(s);
      for (const k of kept) expect(out, `${cmd}  →  ${out}`).toContain(k);
    }
  });

  it("leaves ordinary administration commands untouched", async () => {
    for (const cmd of [
      "ls -la /var/log", "apt-get update && apt-get -y upgrade", "systemctl restart nginx", "mkdir -p /srv/app/releases",
      "tar -pxf backup.tar", "ssh -p 2222 deploy@host", "df -h && free -m", "journalctl -u fleet-agent -n 50 --no-pager",
      "grep -r token /etc/nginx", "echo the password policy is fine", "chmod 600 ~/.ssh/id_ed25519", "docker ps --format '{{.Names}}'",
      "useradd -m -s /bin/bash alice", "cat /etc/os-release",
    ]) expect(await redact(cmd), cmd).toBe(cmd);
  });

  it("is idempotent and null-safe", async () => {
    const once = await redact("mysql -uroot -pSecretPw db; curl -u a:b https://x");
    expect(await redact(once)).toBe(once);
    expect((await db.query<{ r: string | null }>(`SELECT public.redact_command(NULL) AS r`)).rows[0].r).toBeNull();
  });

  it("is not callable from the browser", async () => {
    await db.exec("SET ROLE authenticated");
    await expect(db.query(`SELECT public.redact_command('x')`)).rejects.toThrow(DENIED);
    await db.exec("RESET ROLE");
  });
});

// ───────────── monitoring-only servers, and the audit copy end to end ─────────────
describe("remote access switch", () => {
  let db: PGlite;
  const OWN = "c0000000-0000-0000-0000-000000000001"; // owner of W
  const MEM = "c0000000-0000-0000-0000-000000000002"; // member
  const VIE = "c0000000-0000-0000-0000-000000000003"; // viewer
  const ADM = "c0000000-0000-0000-0000-000000000004"; // owner of a DIFFERENT workspace
  const WS = "c1000000-0000-0000-0000-000000000001";
  const WO = "c1000000-0000-0000-0000-000000000002";
  const SRV = "c2000000-0000-0000-0000-000000000001";
  const SRV2 = "c2000000-0000-0000-0000-000000000002";

  const as = async (uid: string, sql: string) => {
    await db.exec(`SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub','${uid}',false), set_config('request.jwt.claims','{}',false);`);
    try { return await db.query<Record<string, unknown>>(sql); } finally { await db.exec("RESET ROLE"); }
  };
  const svc = async (sql: string) => {
    await db.exec("SET ROLE service_role");
    try { return await db.query<Record<string, unknown>>(sql); } finally { await db.exec("RESET ROLE"); }
  };
  const claim = async (server: string) => (await svc(`SELECT * FROM public.claim_commands('${server}', 5)`)).rows;
  const setRemote = (uid: string, server: string, on: boolean) =>
    as(uid, `UPDATE public.servers SET remote_access = ${on} WHERE id = '${server}' RETURNING id`);

  beforeAll(async () => {
    db = await boot(false);
    await db.exec(`
      INSERT INTO auth.users (id,email) VALUES ('${OWN}','o@t.dev'),('${MEM}','m@t.dev'),('${VIE}','v@t.dev'),('${ADM}','a@t.dev');
      SET ROLE service_role;
      INSERT INTO public.workspaces (id,name,created_by) VALUES ('${WS}','W','${OWN}'),('${WO}','Other','${ADM}');
      INSERT INTO public.workspace_members (workspace_id,user_id,role) VALUES
        ('${WS}','${OWN}','owner'),('${WS}','${MEM}','member'),('${WS}','${VIE}','viewer'),('${WO}','${ADM}','owner');
      INSERT INTO public.servers (id,user_id,workspace_id,name,agent_token_hash) VALUES
        ('${SRV}','${OWN}','${WS}','prod','h1'),('${SRV2}','${OWN}','${WS}','other-srv','h2');
      RESET ROLE;`);
  }, 120_000);
  afterAll(async () => { await db?.close(); });

  it("servers allow remote access by default", async () => {
    expect((await as(MEM, `SELECT remote_access FROM public.servers WHERE id='${SRV}'`)).rows).toEqual([{ remote_access: true }]);
  });

  it("only admins and above can flip the switch", async () => {
    expect((await setRemote(MEM, SRV, false)).rows).toHaveLength(0);   // member
    expect((await setRemote(VIE, SRV, false)).rows).toHaveLength(0);   // viewer
    expect((await setRemote(ADM, SRV, false)).rows).toHaveLength(0);   // owner of a different workspace
    expect((await as(MEM, `SELECT remote_access FROM public.servers WHERE id='${SRV}'`)).rows).toEqual([{ remote_access: true }]);
  });

  it("while on, commands queue and are claimed exactly once by the agent", async () => {
    await as(MEM, `INSERT INTO public.commands (server_id,user_id,command) VALUES ('${SRV}','${MEM}','uptime')`);
    expect((await claim(SRV)).map((r) => r.command)).toEqual(["uptime"]);
    expect(await claim(SRV)).toEqual([]); // already running: never handed out twice
  });

  it("turning it off blocks new commands, cancels waiting ones, closes terminals, and is audited", async () => {
    await as(MEM, `INSERT INTO public.commands (id,server_id,user_id,command) VALUES ('d0000000-0000-0000-0000-000000000001','${SRV}','${MEM}','sleep 600')`);
    await svc(`INSERT INTO public.terminal_sessions (id,server_id,user_id,status) VALUES ('d1000000-0000-0000-0000-000000000001','${SRV}','${MEM}','active')`);

    expect((await setRemote(OWN, SRV, false)).rows).toHaveLength(1);

    // new commands are refused for everyone, at the database
    await expect(as(MEM, `INSERT INTO public.commands (server_id,user_id,command) VALUES ('${SRV}','${MEM}','id')`)).rejects.toThrow(DENIED);
    await expect(as(OWN, `INSERT INTO public.commands (server_id,user_id,command) VALUES ('${SRV}','${OWN}','id')`)).rejects.toThrow(DENIED);
    // a command that was still waiting is cancelled, with a reason
    const cancelled = (await svc(`SELECT status, stderr FROM public.commands WHERE id='d0000000-0000-0000-0000-000000000001'`)).rows[0];
    expect(cancelled.status).toBe("failed");
    expect(cancelled.stderr).toContain("turned off");
    // the open terminal is closed
    expect((await svc(`SELECT status FROM public.terminal_sessions WHERE id='d1000000-0000-0000-0000-000000000001'`)).rows).toEqual([{ status: "closed" }]);
    // the audit log says who did it
    const log = await as(OWN, `SELECT user_id, action FROM public.audit_log WHERE action='server.remote_disabled'`);
    expect(log.rows).toEqual([{ user_id: OWN, action: "server.remote_disabled" }]);
  });

  it("even a command that slips in (service role) is never handed to the agent, and no terminal survives", async () => {
    await svc(`INSERT INTO public.commands (server_id,user_id,command) VALUES ('${SRV}','${OWN}','rm -rf /tmp/x')`);
    expect(await claim(SRV)).toEqual([]);
    await svc(`INSERT INTO public.terminal_sessions (id,server_id,user_id,status) VALUES ('d1000000-0000-0000-0000-000000000002','${SRV}','${MEM}','requested')`);
    const poll = (await svc(`SELECT public.terminal_agent_poll('${SRV}','{}'::jsonb,'[]'::jsonb) AS r`)).rows[0].r as { sessions: { id: string; status: string }[] };
    const s = poll.sessions.find((x) => x.id === "d1000000-0000-0000-0000-000000000002");
    expect(s?.status).toBe("closed"); // the agent is told to close it, so no shell is opened
  });

  it("other servers in the same workspace are unaffected", async () => {
    await as(MEM, `INSERT INTO public.commands (server_id,user_id,command) VALUES ('${SRV2}','${MEM}','date')`);
    expect((await claim(SRV2)).map((r) => r.command)).toEqual(["date"]);
  });

  it("turning it back on restores normal operation and is audited", async () => {
    expect((await setRemote(OWN, SRV, true)).rows).toHaveLength(1);
    await as(MEM, `INSERT INTO public.commands (server_id,user_id,command) VALUES ('${SRV}','${MEM}','whoami')`);
    expect((await claim(SRV)).some((r) => r.command === "whoami")).toBe(true);
    expect((await as(OWN, `SELECT count(*)::int AS n FROM public.audit_log WHERE action='server.remote_enabled'`)).rows).toEqual([{ n: 1 }]);
  });

  it("the agent's work-claiming function is not callable from the browser", async () => {
    await expect(as(MEM, `SELECT * FROM public.claim_commands('${SRV}', 5)`)).rejects.toThrow(DENIED);
  });

  it("the audit copy of a queued command is redacted while the command that runs is not", async () => {
    await as(MEM, `INSERT INTO public.commands (id,server_id,user_id,command) VALUES ('d0000000-0000-0000-0000-000000000009','${SRV}','${MEM}','mysql -uroot -pTopSecret99 -e "select 1"')`);
    const real = (await svc(`SELECT command FROM public.commands WHERE id='d0000000-0000-0000-0000-000000000009'`)).rows[0].command as string;
    expect(real).toContain("TopSecret99"); // what actually runs is untouched
    const audited = (await as(OWN, `SELECT detail->>'command' AS c FROM public.audit_log WHERE detail->>'command_id' = 'd0000000-0000-0000-0000-000000000009'`)).rows[0].c as string;
    expect(audited).not.toContain("TopSecret99");
    expect(audited).toContain("mysql");
  });
});
