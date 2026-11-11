# Security notes

## Where user data lives
| Data | Location | Notes |
|---|---|---|
| Email, password hash, sessions | Supabase Auth | Password never stored in plain text |
| Servers (name, hostname, IP, OS, tags, notes, `agent_token`) | `public.servers` | PII-adjacent (IP, hostnames) |
| Metrics | `public.metrics` | Written only by agent routes (service role) |
| Commands + output | `public.commands` | Output may contain secrets printed by servers |
| Terminal I/O | `public.terminal_sessions` | Buffers cleared as acknowledged |
| Playbooks / run logs / costs | `automation_*`, `task_logs`, `cost_metrics` | |
Third parties: Supabase (DB/auth), hosting provider, Cloudflare Turnstile (optional), Google Fonts.

## Teams and roles
Data belongs to a **workspace** (team); people belong to workspaces with a role:
- **owner**: everything, incl. managing admins/owners and deleting the team
- **admin**: add/edit/delete servers, rotate tokens, edit playbooks, invite members/viewers, read the audit log
- **member**: run commands, playbooks and terminals; acknowledge alerts
- **viewer**: read-only (servers, metrics, alerts, playbooks). Note: viewers can also read each server's "connection notes" — don't put secrets there.

Enforced in two places: row-level security in the database (`has_role()` / `server_has_role()`, tested in `src/db/migrations.test.ts`) and explicit role checks in every server route that uses the service role (`getRole` / `getServerAccess`). Removing or demoting someone cuts off an open terminal on its next poll. A workspace can never lose its last owner (DB trigger). Invitations are accepted only for a **confirmed** email address.

## Two-factor sign-in (TOTP)
Users can add an authenticator app on the Account page. Once a verified factor exists, a password alone never grants access, enforced three times over:
- **Screen:** the app shows only the code prompt until the session reaches aal2.
- **API:** every route that authenticates the browser (`getUserFromRequest`) returns 401 `mfa_required` for an aal1 session when the user has a verified factor (fails closed if the auth API errors; answers cached 30 s).
- **Database:** `has_role()` / `mfa_ok()` deny any workspace data to an aal1 session of a user who has a factor, so a stolen password used straight against Supabase gets nothing.
Teams can **require** 2FA (owner setting): members without it are locked out of that team until they set it up (database + API + a notice in the app). An owner can reset a teammate's 2FA from the Team page if they lose their authenticator (audited). There are no recovery codes: a sole owner who loses their authenticator must use the Supabase dashboard (Authentication → Users → the user → remove factor).

## Controls
- RLS on every table; `anon` has no privileges; child-row ownership enforced in policies.
- Agent endpoints: per-server token, per-token and per-IP rate limits, strict zod schemas, no CORS.
- Browser terminal endpoints: Supabase JWT + ownership check, per-user rate limits.
- Security headers via `src/start.ts` (`buildSecurityHeaders` in `src/lib/security.server.ts`).
- Errors: generic to users (`src/lib/errors.ts`, `errors.*` in security.server); detail logged server-side only.
- DB CHECK constraints are the server-side validation for direct client writes.

- Agent tokens: only a SHA-256 hash is stored; the raw token is shown once (create / rotate) and the hash is not readable from the browser.
- Rate-limit client IP uses only platform-set headers (x-vercel-forwarded-for / x-real-ip); never cf-connecting-ip unless Cloudflare is in front.
- Per-user row caps (DB triggers) and a 200-server cap per account.
- Commands stuck running >2h (agent restart) or pending >24h are marked failed by the daily purge.
- Audit log (`audit_log`, per workspace; admins read all of it, members read their own events): every queued command (DB trigger, so it cannot be skipped), server create/delete, token rotation, terminal session start and data export. Read-only for users; kept 365 days.
- Alerts (`alerts`, `evaluate_alerts()` via pg_cron each minute): server silent >5 min, CPU/memory/disk >= 90% (clears < 80%). Users can only acknowledge.
- Tests: `npm test` runs all migrations on a real Postgres engine (PGlite) and checks RLS, grants, triggers and the maintenance functions, with Supabase's "expose new tables" both on and off. CI runs typecheck, tests, build and `npm audit` on every push.
- Retention: metrics 30d, terminal sessions 7d, commands 90d (`purge_old_data()`, pg_cron).

## Known risks
- CSP allows `'unsafe-inline'` scripts (TanStack Start inline hydration). Move to nonces when supported.
- In-memory rate limiter is per instance; add a WAF/Redis limiter for strict global limits.
- The agent and terminal run as root on the target server by design. Queued commands and playbooks execute as root via `bash` (30 min timeout, max 5 at a time, output capped at 150 KB). Command text and output are stored in the database.
- Terminal input/output buffers are read-modify-write in the database (not atomic): under a race a keystroke can be lost or replayed on the owner's own server. Integrity only, no cross-account impact.
- The install one-liner puts the token in the shell history of the machine where it is pasted; clear it afterwards (history -d) or rotate the token.

## Operator checklist
- Apply all migrations in `supabase/migrations` in order (enable pg_cron first for the retention and alert jobs). The last one, `explicit_grants`, makes the app work with Supabase's "Automatically expose new tables" turned off.
- Supabase Auth: enable email confirmation, leaked-password protection, min password length 10, CAPTCHA (Turnstile secret), and add the production URL to redirect URLs.
- Set `VITE_TURNSTILE_SITE_KEY` in the host environment.
- Never prefix secrets with `VITE_`.
