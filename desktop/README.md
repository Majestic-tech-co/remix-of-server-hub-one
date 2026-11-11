# Fleet desktop app

The Fleet website in its own window, plus **direct SSH from your computer** to your servers (like Termius).
Typing goes straight from this computer to the server over SSH: no web hops, no database in the path.

Everything else (login, teams, roles, two-factor, alerts, playbooks, the agent terminal) is the normal Fleet
website, so it updates whenever the site does.

## Run it

```bash
cd desktop
npm ci          # downloads Electron (about 100 MB) the first time
npm start       # builds and opens the app
```

Development against a local site: `FLEET_APP_URL=http://localhost:5173 npm start` (ignored in packaged builds).

## Build installers

```bash
npm run dist    # needs network the first time (electron-builder); output in desktop/release/
```

Windows (NSIS installer), macOS (dmg) and Linux (AppImage, deb). Packaging has not been exercised from CI yet, and
code signing / notarization (required for smooth installs on macOS and Windows) is not set up.

## Check that it works

```bash
npm run smoke   # launches the real app and runs 16 end-to-end checks (see smoke/smoke.mjs)
```

It starts a real SSH server and a local test page, then verifies through the real bridge, IPC and OS keychain
that the page cannot reach Node, secrets are never returned, a fingerprint must be approved, a real SSH session
works, and navigation away from the site is blocked.

## Using it

Open a server, choose the **SSH** tab, enter host / port / username, then either choose your private key file or
type a password. Click **Connect**. The first time, check the fingerprint it shows against your server
(`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`) and click *Trust and connect*.

## How credentials are handled

- Stored **only on this computer**, encrypted with the operating system's secure storage (Windows DPAPI,
  macOS Keychain, Linux libsecret). **Never sent to Fleet or Supabase.**
- If the OS cannot provide real encryption (e.g. Linux without a keyring), the app **refuses to save secrets**
  rather than store them in plain text.
- The web page can save a secret but **cannot read it back**. Private keys are chosen and read by the app itself,
  so the page never sees the file contents.
- The app never uses an SSH agent or other keys on your machine: only what you saved for that server.

## Host keys

Trust on first use, then pinned per server. If a server later presents a different key, the app **refuses to send
your login** and shows a warning. You can deliberately forget the old identity if you reinstalled the server.

## Threat model and limits (read this)

- **The app loads the Fleet website and gives it the SSH bridge.** If the website itself were compromised (for
  example by cross-site scripting), an attacker could open SSH sessions using the connections you saved, as
  you. Defences: only the exact Fleet origin can call the bridge (checked on every call, top frame only), the page
  cannot read secrets, navigation is pinned to the Fleet origin, no Node.js in the page, strict CSP from the
  site. This is the main reason to keep the site's own security tight.
- **Direct SSH bypasses Fleet's controls.** Fleet's roles, two-factor and audit log do not apply to a direct SSH
  session: who can connect is decided by SSH keys on the *server*. The SSH tab is only shown to members and above,
  but that is cosmetic. Use your servers' own SSH logs for auditing, and remove a person's key from the server
  to revoke their access. Passing a computer to someone gives them its saved connections.
- **Servers must be reachable** on their SSH port from your computer (directly, through a VPN such as Tailscale,
  or a jump host). The Fleet agent's outbound-only model remains the way to reach servers behind a firewall.
- **No jump hosts, port forwarding or SFTP yet.**
- Not code-signed, so operating systems will warn on first install until signing certificates are set up.

## Layout

- `src/ssh.ts` SSH sessions and host-key checks · `src/store.ts` keychain-backed profile store
- `src/api.ts` the only surface the web page can use (origin-checked, validated) · `src/security.ts` helpers
- `src/main.ts` Electron main process (locked-down window) · `src/preload.ts` the `window.fleetDesktop` bridge
- Tests run against a real in-process SSH server: `npm test` from the repository root.
