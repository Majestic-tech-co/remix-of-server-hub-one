// End-to-end smoke test of the REAL Electron app (needs the Electron binary: `npm ci` in desktop/).
//   npm run smoke
//
// What it does: starts an in-process SSH server and a tiny local web page, launches the app pointed at that
// page (dev builds may use http://localhost), and lets the page drive the real preload bridge + real IPC +
// the real OS keychain. It checks that the window starts, that the page cannot reach Node, that secrets are
// never returned, that navigation is pinned, and that a complete SSH session works.
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const tmp = mkdtempSync(join(tmpdir(), "fleet-smoke-"));
// the bundled test helper must sit inside desktop/ so it can find ssh2 in desktop/node_modules (git-ignored)
const scratch = join(root, ".smoke");

// 1. a real SSH server (reusing the test helper) -------------------------------------------------
await build({
  entryPoints: [join(root, "src/testing.ts")], bundle: true, platform: "node", format: "cjs",
  packages: "external", outfile: join(scratch, "testing.cjs"), logLevel: "silent",
});
const { startServer, newKeyPair, USER, PASSWORD } = require(join(scratch, "testing.cjs"));
const sshServer = await startServer({ hostKey: newKeyPair().private });

// 2. a local page that exercises the bridge, and a place to report back ---------------------------------
const PAGE = `<!doctype html><meta charset="utf-8"><title>smoke</title><body>smoke<script>
(async () => {
  const SID = "11111111-2222-4333-8444-555555555555";
  const f = window.fleetDesktop, r = {};
  const step = async (name, fn) => { try { r[name] = await fn(); } catch (e) { r[name] = { threw: String(e) }; } };
  r.hasBridge = typeof f === "object" && f !== null;
  r.version = f && f.version;
  r.bridgeKeys = f ? Object.keys(f).sort() : [];
  r.typeofRequire = typeof require; r.typeofProcess = typeof process; r.typeofBuffer = typeof Buffer;
  r.typeofIpc = typeof window.ipcRenderer; r.typeofElectron = typeof window.electron;
  await step("badInput", () => f.profiles.get("nope"));
  await step("saved", () => f.profiles.save({ serverId: SID, host: "127.0.0.1", port: ${sshServer.port}, username: ${JSON.stringify(USER)}, authType: "password", password: ${JSON.stringify(PASSWORD)} }));
  await step("read", () => f.profiles.get(SID));
  r.leaks = JSON.stringify([r.saved, r.read]).includes(${JSON.stringify(PASSWORD)});
  await step("firstConnect", () => f.ssh.connect(SID, 80, 24));
  const fp = r.firstConnect && r.firstConnect.detail && r.firstConnect.detail.fingerprint;
  await step("wrongTrust", () => f.ssh.trust(SID, "SHA256:" + "A".repeat(43)));
  await step("trust", () => f.ssh.trust(SID, fp));
  await step("connect", () => f.ssh.connect(SID, 80, 24));
  if (r.connect && r.connect.ok) {
    const sid = r.connect.sessionId; let seen = "";
    const off = f.ssh.onData((id, bytes) => { if (id === sid) seen += new TextDecoder().decode(bytes); });
    f.ssh.write(sid, "echo smoke-ok\\n");
    for (let i = 0; i < 100 && !seen.includes("echo smoke-ok"); i++) await new Promise((x) => setTimeout(x, 50));
    r.echoed = seen.includes("echo smoke-ok"); r.welcome = seen.includes("welcome");
    f.ssh.resize(sid, 120, 40);
    await step("closed", () => f.ssh.close(sid)); off();
  }
  await step("removed", () => f.profiles.remove(SID));
  // navigation lockdown: an off-origin navigation must not change this page
  const before = location.href; try { location.href = "ftp://127.0.0.1/x"; } catch {}
  await new Promise((x) => setTimeout(x, 600));
  r.stayedOnPage = location.href === before;
  r.windowOpenBlocked = window.open("ftp://127.0.0.1/y") === null;
  await fetch("/result", { method: "POST", body: JSON.stringify(r) });
})();
</script>`;

let resolveResult;
const gotResult = new Promise((r) => { resolveResult = r; });
const web = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/result") {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { res.end("ok"); resolveResult(JSON.parse(b)); });
  } else { res.setHeader("Content-Type", "text/html"); res.end(PAGE); }
});
await new Promise((r) => web.listen(0, "localhost", r));
const url = `http://localhost:${web.address().port}`;

// 3. launch the real app ---------------------------------------------------------------------------------
const electron = require("electron"); // path to the Electron binary
const child = spawn(electron, [".", `--user-data-dir=${join(tmp, "profile")}`, "--disable-gpu"], {
  cwd: root, env: { ...process.env, FLEET_APP_URL: url }, stdio: ["ignore", "pipe", "pipe"],
});
let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("timed out waiting for the app")), 60_000));

let exitCode = 0;
try {
  const r = await Promise.race([gotResult, timeout]);
  const checks = [
    ["window loaded and bridge exposed", r.hasBridge === true && r.version === 1],
    ["bridge has only the expected groups", JSON.stringify(r.bridgeKeys) === JSON.stringify(["profiles", "ssh", "version"])],
    ["page has no Node.js (require/process/Buffer)", r.typeofRequire === "undefined" && r.typeofProcess === "undefined" && r.typeofBuffer === "undefined"],
    ["page has no raw ipcRenderer/electron", r.typeofIpc === "undefined" && r.typeofElectron === "undefined"],
    ["bad input rejected generically", r.badInput && r.badInput.ok === false && r.badInput.code === "BAD_INPUT"],
    ["profile saved through the real OS keychain", r.saved && r.saved.ok === true && r.saved.profile && r.saved.profile.hasSecret === true],
    ["secret never returned to the page", r.leaks === false],
    ["first connection stops for fingerprint approval", r.firstConnect && r.firstConnect.code === "HOST_KEY_UNKNOWN"],
    ["a made-up fingerprint cannot be trusted", r.wrongTrust && r.wrongTrust.ok === false],
    ["the shown fingerprint can be trusted", r.trust && r.trust.ok === true],
    ["real SSH session opens", r.connect && r.connect.ok === true],
    ["typed text reaches the server and comes back", r.echoed === true && r.welcome === true],
    ["session closes cleanly", r.closed && r.closed.ok === true],
    ["profile removed", r.removed && r.removed.ok === true],
    ["off-origin navigation blocked", r.stayedOnPage === true],
    ["window.open to another origin blocked", r.windowOpenBlocked === true],
  ];
  let failed = 0;
  for (const [name, ok] of checks) { console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); if (!ok) failed++; }
  if (failed) { exitCode = 1; console.log("\nraw result:", JSON.stringify(r, null, 2)); }
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
} catch (e) {
  exitCode = 1;
  console.error("SMOKE TEST ERROR:", e.message, "\n--- app output ---\n" + log.slice(-2000));
} finally {
  child.kill();
  await sshServer.close().catch(() => {});
  web.close();
  setTimeout(() => { rmSync(tmp, { recursive: true, force: true }); rmSync(scratch, { recursive: true, force: true }); process.exit(exitCode); }, 500);
}
