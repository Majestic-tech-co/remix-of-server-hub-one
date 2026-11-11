import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { utils } from "ssh2";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fingerprintSha256 } from "./security";
import { SshError, SshManager } from "./ssh";
import { ProfileStore } from "./store";
import { fakeBox, newKeyPair, PASSWORD, startServer, until, USER, type TestServer } from "./testing";

const SID = "11111111-2222-4333-8444-555555555555";
const OWNER = 1;

describe("direct SSH (against a real in-process SSH server)", () => {
  let dir: string;
  let store: ProfileStore;
  let hostKeys: ReturnType<typeof newKeyPair>;
  let server: TestServer;
  let out: Map<string, string>;
  let closed: string[];
  let mgr: SshManager;

  const text = (id: string) => out.get(id) ?? "";
  const profile = (over: Partial<{ port: number; authType: "password" | "key" }> = {}, secrets = { password: PASSWORD } as object) =>
    store.saveProfile(SID, { host: "127.0.0.1", port: over.port ?? server.port, username: USER, authType: over.authType ?? "password" }, secrets);
  /** connect, accept the first-use fingerprint, connect again */
  async function connectTrusting() {
    try {
      return await mgr.connect(SID, 80, 24, OWNER);
    } catch (e) {
      const err = e as SshError;
      expect(err.code).toBe("HOST_KEY_UNKNOWN");
      mgr.trustHostKey(SID, err.detail!.fingerprint);
      return mgr.connect(SID, 80, 24, OWNER);
    }
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "fleet-ssh-"));
    store = new ProfileStore(join(dir, "profiles.json"), fakeBox());
    hostKeys = newKeyPair();
    server = await startServer({ hostKey: hostKeys.private });
    out = new Map();
    closed = [];
    mgr = new SshManager(
      store,
      {
        onData: (id, d) => out.set(id, (out.get(id) ?? "") + d.toString()),
        onClose: (id) => closed.push(id),
      },
      { readyTimeoutMs: 3000 }
    );
  });
  afterEach(async () => {
    mgr.closeAll();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("password login: types a command and gets the echo back", async () => {
    profile();
    const { sessionId } = await connectTrusting();
    await until(() => text(sessionId).includes("welcome"));
    mgr.write(sessionId, OWNER, "echo hi\n");
    await until(() => text(sessionId).includes("echo hi"));
    expect(server.received.join("")).toContain("echo hi");
  });

  it("key login works, including a passphrase-protected key", async () => {
    for (const passphrase of [undefined, "s3cret-pass"]) {
      const kp = newKeyPair(passphrase);
      await server.close();
      server = await startServer({ hostKey: hostKeys.private, authorizedKey: kp.public });
      store.removeProfile(SID);
      profile({ authType: "key" }, { privateKey: kp.private, ...(passphrase ? { passphrase } : {}) });
      const { sessionId } = await connectTrusting();
      await until(() => text(sessionId).includes("welcome"));
      mgr.close(sessionId, OWNER);
      await until(() => closed.includes(sessionId));
    }
  });

  it("a wrong password is reported as AUTH_FAILED, without leaking the password", async () => {
    profile({}, { password: "wrong-password-123" });
    let err: SshError | undefined;
    try { await connectTrusting(); } catch (e) { err = e as SshError; }
    expect(err?.code).toBe("AUTH_FAILED");
    expect(err?.message).not.toContain("wrong-password-123");
  });

  it("first connection stops for fingerprint approval; the fingerprint matches the server's real key", async () => {
    profile();
    const real = fingerprintSha256((utils.parseKey(hostKeys.public) as { getPublicSSH(): Buffer }).getPublicSSH());
    const err = await mgr.connect(SID, 80, 24, OWNER).catch((e) => e as SshError);
    expect(err).toBeInstanceOf(SshError);
    expect((err as SshError).code).toBe("HOST_KEY_UNKNOWN");
    expect((err as SshError).detail?.fingerprint).toBe(real);
    expect(real).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(mgr.openCount).toBe(0); // nothing connected, nothing sent, until the user approves
    expect(server.received).toEqual([]);
  });

  it("only the fingerprint the app just showed can be trusted", async () => {
    profile();
    const err = (await mgr.connect(SID, 80, 24, OWNER).catch((e) => e)) as SshError;
    expect(() => mgr.trustHostKey(SID, "SHA256:" + "A".repeat(43))).toThrow(SshError);
    mgr.trustHostKey(SID, err.detail!.fingerprint);
    const { sessionId } = await mgr.connect(SID, 80, 24, OWNER);
    await until(() => text(sessionId).includes("welcome"));
  });

  it("a changed host key is a hard stop (possible man-in-the-middle)", async () => {
    profile();
    await connectTrusting(); // trusts key #1
    mgr.closeAll();
    const port = server.port;
    await server.close();
    server = await startServer({ hostKey: newKeyPair().private, port }); // same address, different identity
    const err = (await mgr.connect(SID, 80, 24, OWNER).catch((e) => e)) as SshError;
    expect(err.code).toBe("HOST_KEY_CHANGED");
    expect(err.detail?.expected).not.toBe(err.detail?.actual);
    // and it cannot be "trusted" away without the user deliberately forgetting the old key
    expect(() => mgr.trustHostKey(SID, err.detail!.actual)).toThrow();
    expect(server.received).toEqual([]);
  });

  it("changing the host address forgets the old host key", async () => {
    profile();
    await connectTrusting();
    expect(store.getHostKey(SID)).not.toBeNull();
    store.saveProfile(SID, { host: "localhost", port: server.port, username: USER, authType: "password" });
    expect(store.getHostKey(SID)).toBeNull();
  });

  it("resize reaches the server", async () => {
    profile();
    const { sessionId } = await connectTrusting();
    mgr.resize(sessionId, OWNER, 132, 43);
    await until(() => server.resizes.length > 0);
    expect(server.resizes.at(-1)).toEqual({ cols: 132, rows: 43 });
  });

  it("closing ends the session and later writes fail", async () => {
    profile();
    const { sessionId } = await connectTrusting();
    mgr.close(sessionId, OWNER);
    await until(() => closed.includes(sessionId));
    expect(() => mgr.write(sessionId, OWNER, "x")).toThrow(SshError);
  });

  it("a window cannot read or control another window's session", async () => {
    profile();
    const { sessionId } = await connectTrusting();
    expect(() => mgr.write(sessionId, 999, "rm -rf /")).toThrow(SshError);
    expect(() => mgr.resize(sessionId, 999, 100, 30)).toThrow(SshError);
    expect(() => mgr.close(sessionId, 999)).toThrow(SshError);
    mgr.closeAllFor(999);
    expect(mgr.openCount).toBe(1);
    mgr.closeAllFor(OWNER);
    await until(() => mgr.openCount === 0);
  });

  it("the server dropping the connection is reported", async () => {
    profile();
    const { sessionId } = await connectTrusting();
    server.dropAll(); // the server (or the network) dies underneath an open session
    await until(() => closed.includes(sessionId));
    expect(mgr.openCount).toBe(0);
  });

  it("refused connections give a friendly error", async () => {
    const dead = await startServer({ hostKey: hostKeys.private });
    const port = dead.port;
    await dead.close();
    profile({ port });
    const err = (await mgr.connect(SID, 80, 24, OWNER).catch((e) => e)) as SshError;
    expect(err.code).toBe("REFUSED");
  });

  it("refuses to connect with no saved profile or secret", async () => {
    expect(((await mgr.connect(SID, 80, 24, OWNER).catch((e) => e)) as SshError).code).toBe("NO_PROFILE");
    store.saveProfile(SID, { host: "127.0.0.1", port: server.port, username: USER, authType: "password" });
    expect(((await mgr.connect(SID, 80, 24, OWNER).catch((e) => e)) as SshError).code).toBe("NO_SECRET");
  });

  it("limits how many sessions can be open", async () => {
    const small = new SshManager(store, { onData: () => {}, onClose: () => {} }, { maxSessions: 1, readyTimeoutMs: 3000 });
    profile();
    store.setHostKey(SID, fingerprintSha256((utils.parseKey(hostKeys.public) as { getPublicSSH(): Buffer }).getPublicSSH()));
    await small.connect(SID, 80, 24, OWNER);
    expect(((await small.connect(SID, 80, 24, OWNER).catch((e) => e)) as SshError).code).toBe("TOO_MANY");
    small.closeAll();
  });

  it("secrets never end up in the profile file in plain text", async () => {
    const kp = newKeyPair("pp-1234");
    profile({ authType: "key" }, { privateKey: kp.private, passphrase: "pp-1234" });
    const raw = readFileSync(join(dir, "profiles.json"), "utf8");
    expect(raw).not.toContain("pp-1234");
    expect(raw).not.toContain("OPENSSH PRIVATE KEY");
    expect(raw).not.toContain(PASSWORD);
  });
});
