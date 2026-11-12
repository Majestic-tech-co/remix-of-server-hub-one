import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { boot, DENIED } from "./harness";

const OWN = "a0000000-0000-0000-0000-000000000012";
const VIE = "a0000000-0000-0000-0000-000000000014";
const OTH = "a0000000-0000-0000-0000-000000000016";
const W = "b1000000-0000-0000-0000-000000000011";
const WO = "b1000000-0000-0000-0000-000000000012";
const S = "b2000000-0000-0000-0000-000000000011";
const SO = "b2000000-0000-0000-0000-000000000012";

describe.each([false, true])("server snapshots (expose new tables: %s)", (expose) => {
  let db: PGlite;
  const as = async (uid: string, sql: string) => {
    await db.exec(`SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub','${uid}',false);`);
    try { return await db.query<Record<string, unknown>>(sql); }
    finally { await db.exec("RESET ROLE; SELECT set_config('request.jwt.claim.sub', '', false)"); }
  };
  const svc = async (sql: string) => {
    await db.exec("SET ROLE service_role");
    try { return await db.query<Record<string, unknown>>(sql); } finally { await db.exec("RESET ROLE"); }
  };

  beforeAll(async () => {
    db = await boot(expose);
    await db.exec(`
      INSERT INTO auth.users (id,email) VALUES ('${OWN}','o@t.dev'),('${VIE}','v@t.dev'),('${OTH}','x@t.dev');
      SET ROLE service_role;
      INSERT INTO public.workspaces (id,name,created_by) VALUES ('${W}','W','${OWN}'),('${WO}','O','${OTH}');
      INSERT INTO public.workspace_members (workspace_id,user_id,role) VALUES ('${W}','${OWN}','owner'),('${W}','${VIE}','viewer'),('${WO}','${OTH}','owner');
      INSERT INTO public.servers (id,user_id,workspace_id,name,agent_token_hash) VALUES ('${S}','${OWN}','${W}','s','h1'),('${SO}','${OTH}','${WO}','o','h2');
      RESET ROLE;`);
  }, 120_000);
  afterAll(async () => { await db?.close(); });

  it("the site (service role) stores a snapshot; the team is filled in from the server, whatever is sent", async () => {
    await svc(`INSERT INTO public.server_snapshots (server_id, workspace_id, data) VALUES ('${S}', '${S}', '{"services":[]}')
               ON CONFLICT (server_id) DO UPDATE SET data = EXCLUDED.data`);
    expect((await svc(`SELECT workspace_id FROM public.server_snapshots WHERE server_id='${S}'`)).rows).toEqual([{ workspace_id: W }]);
    // a second report replaces the first
    await svc(`INSERT INTO public.server_snapshots (server_id, workspace_id, data) VALUES ('${S}', '${S}', '{"services":[1]}')
               ON CONFLICT (server_id) DO UPDATE SET data = EXCLUDED.data`);
    expect((await svc(`SELECT count(*)::int AS n FROM public.server_snapshots WHERE server_id='${S}'`)).rows).toEqual([{ n: 1 }]);
  });

  it("team viewers can read it; other teams cannot; nobody can write from the browser", async () => {
    expect((await as(VIE, `SELECT server_id FROM public.server_snapshots`)).rows).toHaveLength(1);
    expect((await as(OTH, `SELECT server_id FROM public.server_snapshots WHERE server_id='${S}'`)).rows).toHaveLength(0);
    await expect(as(OWN, `INSERT INTO public.server_snapshots (server_id, workspace_id, data) VALUES ('${SO}','${WO}','{}')`)).rejects.toThrow(DENIED);
    await expect(as(OWN, `UPDATE public.server_snapshots SET data='{}'`)).rejects.toThrow(DENIED);
    await expect(as(OWN, `DELETE FROM public.server_snapshots`)).rejects.toThrow(DENIED);
  });

  it("rejects non-objects and oversized data", async () => {
    await expect(svc(`UPDATE public.server_snapshots SET data='[1]' WHERE server_id='${S}'`)).rejects.toThrow(/violates|snapshot_is_object/i);
    await expect(svc(`UPDATE public.server_snapshots SET data = jsonb_build_object('x', repeat('a', 300000)) WHERE server_id='${S}'`)).rejects.toThrow(/violates|snapshot_size/i);
  });

  it("goes away with its server", async () => {
    await svc(`DELETE FROM public.servers WHERE id='${S}'`);
    expect((await svc(`SELECT count(*)::int AS n FROM public.server_snapshots`)).rows).toEqual([{ n: 0 }]);
  });
});
