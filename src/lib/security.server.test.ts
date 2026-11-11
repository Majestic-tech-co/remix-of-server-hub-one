import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSecurityHeaders,
  clientIp,
  generateAgentToken,
  rateLimit,
  roleAtLeast,
  sha256Hex,
} from "./security.server";

describe("rateLimit", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("allows up to the limit then blocks", () => {
    const key = "t-block";
    for (let i = 0; i < 3; i++) expect(rateLimit(key, 3, 60_000).ok).toBe(true);
    const blocked = rateLimit(key, 3, 60_000);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfter).toBeGreaterThan(0);
  });

  it("resets after the window", () => {
    const key = "t-reset";
    for (let i = 0; i < 3; i++) rateLimit(key, 2, 1_000);
    expect(rateLimit(key, 2, 1_000).ok).toBe(false);
    vi.advanceTimersByTime(1_001);
    expect(rateLimit(key, 2, 1_000).ok).toBe(true);
  });

  it("keeps separate buckets per key", () => {
    for (let i = 0; i < 5; i++) rateLimit("t-a", 2, 60_000);
    expect(rateLimit("t-b", 2, 60_000).ok).toBe(true);
  });
});

describe("clientIp", () => {
  const req = (h: Record<string, string>) => new Request("https://x.test", { headers: h });

  it("never trusts the forgeable cf-connecting-ip header", () => {
    expect(clientIp(req({ "cf-connecting-ip": "6.6.6.6", "x-real-ip": "1.2.3.4" }))).toBe("1.2.3.4");
  });
  it("prefers the Vercel-set header", () => {
    expect(clientIp(req({ "x-vercel-forwarded-for": "9.9.9.9, 8.8.8.8", "x-real-ip": "1.2.3.4" }))).toBe("9.9.9.9");
  });
  it("falls back to unknown", () => {
    expect(clientIp(req({}))).toBe("unknown");
  });
});

describe("tokens", () => {
  it("sha256Hex matches the known test vector", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("generates unique 192-bit hex tokens", () => {
    const a = generateAgentToken();
    const b = generateAgentToken();
    expect(a).toMatch(/^[0-9a-f]{48}$/);
    expect(a).not.toBe(b);
  });
});

describe("security headers", () => {
  const h = buildSecurityHeaders();
  it("blocks framing and plugins", () => {
    expect(h["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
    expect(h["Content-Security-Policy"]).toContain("object-src 'none'");
    expect(h["X-Frame-Options"]).toBe("DENY");
  });
  it("does not allow eval or wildcard sources", () => {
    expect(h["Content-Security-Policy"]).not.toContain("unsafe-eval");
    expect(h["Content-Security-Policy"]).not.toMatch(/script-src[^;]*\*/);
  });
  it("sets nosniff and a referrer policy", () => {
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
  });
});

describe("roleAtLeast", () => {
  it("orders viewer < member < admin < owner", () => {
    expect(roleAtLeast("owner", "admin")).toBe(true);
    expect(roleAtLeast("admin", "admin")).toBe(true);
    expect(roleAtLeast("member", "admin")).toBe(false);
    expect(roleAtLeast("viewer", "member")).toBe(false);
    expect(roleAtLeast("member", "viewer")).toBe(true);
  });
  it("denies missing and unknown roles", () => {
    expect(roleAtLeast(null, "viewer")).toBe(false);
    expect(roleAtLeast(undefined, "viewer")).toBe(false);
    expect(roleAtLeast("superuser", "viewer")).toBe(false);
    expect(roleAtLeast("constructor", "viewer")).toBe(false);
  });
});
