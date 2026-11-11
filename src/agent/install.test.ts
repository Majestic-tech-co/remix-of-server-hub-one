import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const script = readFileSync(new URL("./install.sh", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const hasBash = spawnSync("bash", ["--version"]).status === 0;

describe("agent installer (install.sh)", () => {
  it.skipIf(!hasBash)("is valid bash", () => {
    const r = spawnSync("bash", ["-n"], { input: script });
    expect(r.status, r.stderr?.toString()).toBe(0);
  });

  it("never passes the token as a command-line argument", () => {
    // The token may only reach curl through the root-only config file.
    expect(script).not.toMatch(/-H\s+"X-Fleet-Token/);
    expect(script).toContain("-K /etc/fleet-agent.curl");
  });

  it("creates secret files with a restrictive umask", () => {
    expect(script).toMatch(/umask 077[\s\S]*fleet-agent\.conf/);
    expect(script).toContain("chmod 600 /etc/fleet-agent.conf /etc/fleet-agent.curl");
  });

  it("sends request bodies via stdin, not arguments", () => {
    expect(script).toContain("--data-binary @-");
  });
});
