import { describe, expect, it } from "vitest";
import { isSafeDownloadUrl, pickLatestInstaller, type GhRelease } from "./desktopRelease.server";
import { compareVersions, parseVersion } from "./semver";

const asset = (name: string, size = 100) => ({ name, size, url: `https://api.github.com/repos/o/r/releases/assets/${name}` });
const rel = (tag: string, assets: string[], over: Partial<GhRelease> = {}): GhRelease => ({
  tag_name: tag, draft: false, prerelease: false, assets: assets.map((n) => asset(n)), ...over,
});

describe("semver helpers", () => {
  it("parses plain versions only", () => {
    expect(parseVersion("1.2.3")).toEqual([1, 2, 3]);
    expect(parseVersion("v0.10.0")).toEqual([0, 10, 0]);
    for (const bad of ["1.2", "1.2.3-beta", "a.b.c", "", "1.2.3.4", "1e3.0.0"]) expect(parseVersion(bad), bad).toBeNull();
  });
  it("compares numerically, not as text", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("0.1.0", "0.1.1")).toBeLessThan(0);
    expect(compareVersions("unknown", "1.0.0")).toBe(0); // never claim an update from garbage
  });
});

describe("choosing the newest installer", () => {
  it("picks the highest version, not the most recently listed", () => {
    const latest = pickLatestInstaller([
      rel("desktop-v0.2.0", ["Fleet-Setup-0.2.0.exe"]),
      rel("desktop-v0.10.0", ["Fleet-Setup-0.10.0.exe", "SHA256SUMS.txt"]),
      rel("desktop-v0.9.0", ["Fleet-Setup-0.9.0.exe"]),
    ]);
    expect(latest?.version).toBe("0.10.0");
    expect(latest?.asset.name).toBe("Fleet-Setup-0.10.0.exe");
  });

  it("ignores drafts, pre-releases, other tags, and releases without a matching installer", () => {
    expect(pickLatestInstaller([
      rel("desktop-v9.0.0", ["Fleet-Setup-9.0.0.exe"], { draft: true }),
      rel("desktop-v8.0.0", ["Fleet-Setup-8.0.0.exe"], { prerelease: true }),
      rel("v7.0.0", ["Fleet-Setup-7.0.0.exe"]),
      rel("desktop-v6.0.0", ["SHA256SUMS.txt"]),
      rel("desktop-v5.0.0", ["Fleet-Setup-4.0.0.exe"]),           // wrong version inside
      rel("desktop-v4.0.0", ["Fleet-Setup-4.0.0.exe.blockmap"]),  // not the installer
      rel("desktop-vevil", ["Fleet-Setup-0.0.1.exe"]),
    ])).toBeNull();
    expect(pickLatestInstaller([])).toBeNull();
    const ok = pickLatestInstaller([rel("desktop-v1.0.0", ["Fleet-Setup-1.0.0.exe"]), rel("desktop-v9.0.0", [], { draft: true })]);
    expect(ok?.version).toBe("1.0.0");
  });
});

describe("download link safety", () => {
  it("allows only https links on GitHub's own hosts", () => {
    for (const ok of [
      "https://objects.githubusercontent.com/github-production-release-asset/1234?X-Amz-Signature=abc",
      "https://release-assets.githubusercontent.com/x", "https://github.com/o/r/releases/download/t/f.exe",
    ]) expect(isSafeDownloadUrl(ok), ok).toBe(true);
    for (const bad of [
      "http://objects.githubusercontent.com/x", "https://evil.example/github.com", "https://github.com.evil.example/x",
      "https://githubusercontent.com.evil.io/x", "https://user:pw@github.com/x", "javascript:alert(1)", "file:///c:/x", "", null, undefined,
      "//objects.githubusercontent.com/x",
    ]) expect(isSafeDownloadUrl(bad as string), String(bad)).toBe(false);
  });
});
