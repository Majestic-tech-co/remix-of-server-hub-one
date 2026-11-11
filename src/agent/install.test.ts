import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (name: string) =>
  readFileSync(new URL(`./${name}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

const script = read("install.sh");
const uninstall = read("uninstall.sh");
const hasBash = spawnSync("bash", ["--version"]).status === 0;
const hasPython = spawnSync("python3", ["--version"]).status === 0; // (on Windows python3 may be a Store stub)

describe("agent uninstaller (uninstall.sh)", () => {
  it.skipIf(!hasBash)("is valid bash", () => {
    const r = spawnSync("bash", ["-n"], { input: uninstall });
    expect(r.status, r.stderr?.toString()).toBe(0);
  });

  it("only deletes fixed Fleet paths (no variable expansion in rm)", () => {
    const rmLines = uninstall.split("\n").filter((l) => /^\s*rm\b/.test(l));
    expect(rmLines.length).toBeGreaterThan(0);
    for (const l of rmLines) {
      if (l.includes("/etc/systemd/system/")) continue; // unit name comes from a fixed loop list
      expect(l).not.toContain("$");
      expect(l).toMatch(/\/(opt|var\/lib)\/fleet-agent|\/etc\/fleet-agent/);
    }
  });
});

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

  it("decodes keystroke chunks one per line (padding between chunks must not drop input)", () => {
    expect(script).toContain('ib64.split("\\n")');
    expect(script).not.toMatch(/raw = base64\.b64decode\(ib64\)/);
  });

  it.skipIf(!hasPython)("the embedded terminal agent is valid python", () => {
    const m = /<<'PYAGENT'\n([\s\S]*?)\nPYAGENT/.exec(script);
    expect(m).toBeTruthy();
    const py = spawnSync("python3", ["-c", "import sys; compile(sys.stdin.read(), 'terminal.py', 'exec')"], { input: m![1] });
    expect(py.status, py.stderr?.toString()).toBe(0);
  });

  it("the terminal agent reuses one connection instead of reconnecting for every poll", () => {
    expect(script).toContain("_conn = None");
    expect(script).not.toMatch(/conn\s*=\s*conn_cls\([^)]*\)\s*\n\s*payload/);
    expect(script).not.toMatch(/conn\.close\(\)\s*\n\s*if r\.status/);
  });

  it("sends request bodies via stdin, not arguments", () => {
    expect(script).toContain("--data-binary @-");
  });
});
