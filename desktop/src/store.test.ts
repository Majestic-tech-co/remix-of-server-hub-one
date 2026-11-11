import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isAllowedOrigin, ProfileInput, TrustInput, WriteInput } from "./security";
import { ProfileStore, StoreError } from "./store";
import { fakeBox } from "./testing";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const META = { host: "10.0.0.5", port: 22, username: "root", authType: "password" as const };

describe("profile store", () => {
  let dir: string;
  let file: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "fleet-store-")); file = join(dir, "p.json"); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns profiles without ever exposing the secret", () => {
    const s = new ProfileStore(file, fakeBox());
    s.saveProfile(A, META, { password: "hunter2-long" });
    const p = s.getProfile(A)!;
    expect(p).toEqual({ ...META, hasSecret: true, trustedFingerprint: null });
    expect(JSON.stringify(p)).not.toContain("hunter2");
    expect(s.getSecrets(A)).toEqual({ password: "hunter2-long" });
  });

  it("encrypts secrets at rest", () => {
    new ProfileStore(file, fakeBox()).saveProfile(A, META, { password: "hunter2-long" });
    expect(readFileSync(file, "utf8")).not.toContain("hunter2");
  });

  it("refuses to store secrets if the OS keychain is unavailable (no plaintext fallback)", () => {
    const s = new ProfileStore(file, fakeBox(false));
    expect(() => s.saveProfile(A, META, { password: "x-secret-1" })).toThrow(StoreError);
    expect(existsSync(file)).toBe(false);
    // metadata alone (no secret) is fine
    s.saveProfile(A, META);
    expect(s.getProfile(A)?.hasSecret).toBe(false);
  });

  it("editing host or port without retyping the secret keeps the secret", () => {
    const s = new ProfileStore(file, fakeBox());
    s.saveProfile(A, META, { password: "hunter2-long" });
    s.saveProfile(A, { ...META, host: "10.0.0.6" });
    expect(s.getSecrets(A)).toEqual({ password: "hunter2-long" });
  });

  it("switching auth method drops the old secret", () => {
    const s = new ProfileStore(file, fakeBox());
    s.saveProfile(A, META, { password: "hunter2-long" });
    s.saveProfile(A, { ...META, authType: "key" });
    expect(s.getProfile(A)?.hasSecret).toBe(false);
  });

  it("profiles are separate per server and can be removed", () => {
    const s = new ProfileStore(file, fakeBox());
    s.saveProfile(A, META, { password: "aaa-secret" });
    s.saveProfile(B, { ...META, host: "10.0.0.9" }, { password: "bbb-secret" });
    expect(s.getSecrets(B)).toEqual({ password: "bbb-secret" });
    s.removeProfile(A);
    expect(s.getProfile(A)).toBeNull();
    expect(s.getProfile(B)).not.toBeNull();
  });

  it("rejects ids that are not UUIDs (no path or key tricks)", () => {
    const s = new ProfileStore(file, fakeBox());
    for (const bad of ["__proto__", "../x", "constructor", ""]) expect(() => s.getProfile(bad)).toThrow(StoreError);
  });

  it("survives a corrupt file instead of crashing", () => {
    writeFileSync(file, "{ not json");
    const s = new ProfileStore(file, fakeBox());
    expect(s.getProfile(A)).toBeNull();
    s.saveProfile(A, META);
    expect(s.getProfile(A)).not.toBeNull();
  });
});

describe("origin allow-list", () => {
  const SITE = "https://server-hub-one.vercel.app";
  it("allows only the exact site origin over https", () => {
    expect(isAllowedOrigin(SITE + "/servers/1", SITE)).toBe(true);
    for (const bad of [
      "http://server-hub-one.vercel.app/", "https://server-hub-one.vercel.app.evil.com/", "https://evil.com/",
      "https://server-hub-one.vercel.app@evil.com/", "file:///etc/passwd", "javascript:alert(1)", "", undefined, null,
      "https://sub.server-hub-one.vercel.app/",
    ]) expect(isAllowedOrigin(bad as string, SITE), String(bad)).toBe(false);
  });
  it("allows http://localhost only in development", () => {
    expect(isAllowedOrigin("http://localhost:5173/", "http://localhost:5173", { dev: true })).toBe(true);
    expect(isAllowedOrigin("http://localhost:5173/", "http://localhost:5173")).toBe(false);
  });
});

describe("input validation", () => {
  it("rejects hostile hosts/usernames and unknown fields", () => {
    const ok = { host: "server.example.com", port: 22, username: "deploy", authType: "key" };
    expect(ProfileInput.safeParse(ok).success).toBe(true);
    for (const bad of [
      { ...ok, host: "a b" }, { ...ok, host: "-oProxyCommand=evil" , username: "x y" }, { ...ok, username: "root;rm" },
      { ...ok, port: 0 }, { ...ok, port: 70000 }, { ...ok, extra: 1 }, { ...ok, authType: "agent" },
    ]) expect(ProfileInput.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });
  it("limits keystroke payload and requires a well-formed fingerprint", () => {
    expect(WriteInput.safeParse({ sessionId: "abcdef123456", data: "x".repeat(1_000_001) }).success).toBe(false);
    expect(TrustInput.safeParse({ serverId: A, fingerprint: "SHA256:short" }).success).toBe(false);
  });
});
