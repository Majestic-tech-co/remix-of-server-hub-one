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

  it("re-installing restarts the services (a running agent would keep the old token and code)", () => {
    expect(script).toContain("systemctl restart fleet-agent.service");
    expect(script).toContain("systemctl restart fleet-terminal.service");
    const commands = script.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n"); // ignore comments
    expect(commands).not.toMatch(/enable --now/);
  });

  it("swaps agent files in atomically instead of overwriting a running script", () => {
    expect(script).toContain('mv -f "$INSTALL_DIR/agent.sh.new" "$INSTALL_DIR/agent.sh"');
    expect(script).toContain('mv -f "$INSTALL_DIR/terminal.py.new" "$INSTALL_DIR/terminal.py"');
    expect(script).not.toMatch(/cat > "\$INSTALL_DIR\/agent\.sh" </);
  });

  describe("HTTPS-only server address", () => {
    const guard = (src: string) => {
      const m = /# --- begin https-guard\n([\s\S]*?)# --- end https-guard/.exec(src);
      expect(m).toBeTruthy();
      return m![1];
    };
    const run = (url: string) =>
      spawnSync("bash", ["-c", guard(script)], { env: { ...process.env, FLEET_URL: url }, encoding: "utf8" });

    it("the installer, the metrics agent and the terminal agent all enforce it", () => {
      expect(script.match(/# --- begin https-guard/g)).toHaveLength(2); // installer + metrics agent
      expect(script).toMatch(/_u\.scheme != "https"/);                  // terminal agent
    });

    it.skipIf(!hasBash)("accepts https and local development addresses", () => {
      for (const ok of ["https://fleet.example.com", "https://server-hub-one.vercel.app", "http://localhost", "http://localhost:3000",
                        "http://127.0.0.1:5173", "http://127.0.0.1/", "http://[::1]:8080"]) {
        expect(run(ok).status, ok).toBe(0);
      }
    });

    it.skipIf(!hasBash)("refuses plain http to anywhere else, and look-alikes", () => {
      for (const bad of ["http://fleet.example.com", "http://localhost.evil.com", "http://127.0.0.1.evil.com", "http://localhost@evil.com",
                         "ftp://fleet.example.com", "fleet.example.com", "HTTPS://fleet.example.com", "https", "", " https://x"]) {
        const r = run(bad);
        expect(r.status, JSON.stringify(bad)).toBe(1);
        expect(r.stderr).toContain("https://");
      }
    });
  });

  it("sends request bodies via stdin, not arguments", () => {
    expect(script).toContain("--data-binary @-");
  });
});
