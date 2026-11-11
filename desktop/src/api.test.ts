import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApi, type Ctx } from "./api";
import { SshManager } from "./ssh";
import { ProfileStore } from "./store";
import { fakeBox, newKeyPair, PASSWORD, startServer, USER, until, type TestServer } from "./testing";

const SITE = "https://server-hub-one.vercel.app";
const SID = "11111111-2222-4333-8444-555555555555";
const GOOD: Ctx = { owner: 1, url: SITE + "/servers/x", isMainFrame: true };
const fpOf = (r: unknown) => (r as { detail: { fingerprint: string } }).detail.fingerprint;

describe("bridge API (what the web page can ask the app to do)", () => {
  let dir: string;
  let store: ProfileStore;
  let server: TestServer;
  let hostKey: ReturnType<typeof newKeyPair>;
  let picked: { name: string; text: string } | null;
  let data: Map<string, string>;
  let api: ReturnType<typeof createApi>;
  let ssh: SshManager;

  const save = (extra: Record<string, unknown> = {}) =>
    api.profileSave(GOOD, { serverId: SID, host: "127.0.0.1", port: server.port, username: USER, authType: "password", password: PASSWORD, ...extra });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "fleet-api-"));
    store = new ProfileStore(join(dir, "p.json"), fakeBox());
    hostKey = newKeyPair();
    server = await startServer({ hostKey: hostKey.private });
    data = new Map();
    picked = null;
    ssh = new SshManager(store, { onData: (id, d) => data.set(id, (data.get(id) ?? "") + d.toString()), onClose: () => {} }, { readyTimeoutMs: 3000 });
    api = createApi({ store, ssh, allowedOrigin: SITE, pickKeyFile: async () => picked });
  });
  afterEach(async () => {
    ssh.closeAll();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses every call from the wrong origin, a sub-frame, or no URL", async () => {
    const bads: Ctx[] = [
      { owner: 1, url: "https://evil.example/", isMainFrame: true },
      { owner: 1, url: SITE + ".evil.example/", isMainFrame: true },
      { owner: 1, url: "http://server-hub-one.vercel.app/", isMainFrame: true },
      { owner: 1, url: SITE + "/", isMainFrame: false },
      { owner: 1, url: undefined, isMainFrame: true },
    ];
    for (const ctx of bads) {
      for (const r of [
        await api.profileGet(ctx, { serverId: SID }),
        await api.profileSave(ctx, { serverId: SID, host: "h", port: 22, username: "u", authType: "password", password: "p" }),
        await api.sshConnect(ctx, { serverId: SID, cols: 80, rows: 24 }),
        await api.sshWrite(ctx, { sessionId: "abcdef123456", data: "x" }),
      ]) {
        expect(r).toMatchObject({ ok: false, code: "FORBIDDEN" });
      }
    }
    expect(store.getProfile(SID)).toBeNull(); // nothing was saved by the rejected calls
  });

  it("saves a profile and returns only public details, never the secret", async () => {
    const r = await save();
    expect(r).toMatchObject({ ok: true, profile: { host: "127.0.0.1", username: USER, authType: "password", hasSecret: true } });
    expect(JSON.stringify(r)).not.toContain(PASSWORD);
    expect(JSON.stringify(await api.profileGet(GOOD, { serverId: SID }))).not.toContain(PASSWORD);
  });

  it("rejects malformed input with a generic error that does not echo the input", async () => {
    const r = await api.profileSave(GOOD, { serverId: SID, host: "bad host!", port: 22, username: "u", authType: "password", password: "SENSITIVE-VALUE" });
    expect(r).toEqual({ ok: false, code: "BAD_INPUT", message: "Invalid input." });
    expect(await api.profileGet(GOOD, { serverId: "not-a-uuid" })).toMatchObject({ ok: false, code: "BAD_INPUT" });
    expect(await api.profileGet(GOOD, null)).toMatchObject({ ok: false, code: "BAD_INPUT" });
    expect(await api.sshWrite(GOOD, { sessionId: "abcdef123456", data: "x", extra: 1 })).toMatchObject({ ok: false, code: "BAD_INPUT" });
  });

  it("end to end: save, first-use fingerprint, trust, connect, type", async () => {
    await save();
    const first = await api.sshConnect(GOOD, { serverId: SID, cols: 80, rows: 24 });
    expect(first).toMatchObject({ ok: false, code: "HOST_KEY_UNKNOWN" });
    const fp = fpOf(first);
    expect(await api.sshTrust(GOOD, { serverId: SID, fingerprint: fp })).toEqual({ ok: true });
    const conn = await api.sshConnect(GOOD, { serverId: SID, cols: 80, rows: 24 });
    expect(conn.ok).toBe(true);
    const sessionId = (conn as { sessionId: string }).sessionId;
    expect(await api.sshWrite(GOOD, { sessionId, data: "ls\n" })).toEqual({ ok: true });
    await until(() => (data.get(sessionId) ?? "").includes("ls"));
    expect(await api.sshResize(GOOD, { sessionId, cols: 120, rows: 40 })).toEqual({ ok: true });
    expect(await api.sshClose(GOOD, { sessionId })).toEqual({ ok: true });
  });

  it("another window cannot use this window's session", async () => {
    await save();
    const first = await api.sshConnect(GOOD, { serverId: SID, cols: 80, rows: 24 });
    await api.sshTrust(GOOD, { serverId: SID, fingerprint: fpOf(first) });
    const sessionId = ((await api.sshConnect(GOOD, { serverId: SID, cols: 80, rows: 24 })) as { sessionId: string }).sessionId;
    const other = { ...GOOD, owner: 2 };
    expect(await api.sshWrite(other, { sessionId, data: "x" })).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await api.sshClose(other, { sessionId })).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  describe("choosing a private key file", () => {
    beforeEach(async () => { await save({ authType: "key", password: undefined }); });

    it("imports a valid key without ever returning its contents", async () => {
      const kp = newKeyPair();
      picked = { name: "id_ed25519", text: kp.private };
      const r = await api.profileImportKey(GOOD, { serverId: SID });
      expect(r).toEqual({ ok: true, imported: true, encrypted: false });
      expect(JSON.stringify(r)).not.toContain("PRIVATE KEY");
      expect(store.getProfile(SID)?.hasSecret).toBe(true);
      expect(readFileSync(join(dir, "p.json"), "utf8")).not.toContain("OPENSSH PRIVATE KEY"); // encrypted at rest
    });

    it("accepts a passphrase-protected key", async () => {
      picked = { name: "k", text: newKeyPair("pw-123456").private };
      expect(await api.profileImportKey(GOOD, { serverId: SID })).toEqual({ ok: true, imported: true, encrypted: true });
    });

    it("rejects public keys, junk files and oversized files", async () => {
      picked = { name: "k.pub", text: newKeyPair().public };
      expect(await api.profileImportKey(GOOD, { serverId: SID })).toMatchObject({ ok: false, code: "BAD_KEY" });
      picked = { name: "notes.txt", text: "hello world" };
      expect(await api.profileImportKey(GOOD, { serverId: SID })).toMatchObject({ ok: false, code: "BAD_KEY" });
      picked = { name: "big", text: "A".repeat(200_000) };
      expect(await api.profileImportKey(GOOD, { serverId: SID })).toMatchObject({ ok: false, code: "BAD_KEY" });
      expect(store.getProfile(SID)?.hasSecret).toBe(false);
    });

    it("cancelling the picker changes nothing", async () => {
      picked = null;
      expect(await api.profileImportKey(GOOD, { serverId: SID })).toEqual({ ok: true, imported: false, encrypted: false });
    });

    it("needs a saved key-based profile first", async () => {
      store.removeProfile(SID);
      expect(await api.profileImportKey(GOOD, { serverId: SID })).toMatchObject({ ok: false, code: "NO_PROFILE" });
      await save(); // password profile
      expect(await api.profileImportKey(GOOD, { serverId: SID })).toMatchObject({ ok: false, code: "BAD_INPUT" });
    });
  });

  it("removing a profile also forgets its pinned host key", async () => {
    await save();
    store.setHostKey(SID, "SHA256:" + "A".repeat(43));
    expect(await api.profileRemove(GOOD, { serverId: SID })).toEqual({ ok: true });
    expect(store.getHostKey(SID)).toBeNull();
  });

  it("the user can deliberately forget a pinned key (e.g. server reinstalled)", async () => {
    await save();
    store.setHostKey(SID, "SHA256:" + "A".repeat(43));
    expect(await api.forgetHostKey(GOOD, { serverId: SID })).toEqual({ ok: true });
    expect(store.getHostKey(SID)).toBeNull();
  });
});
