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
- Retention: metrics 30d, terminal sessions 7d, commands 90d (`purge_old_data()`, pg_cron).

## Known risks
- CSP allows `'unsafe-inline'` scripts (TanStack Start inline hydration). Move to nonces when supported.
- In-memory rate limiter is per instance; add a WAF/Redis limiter for strict global limits.
- The agent and terminal run as root on the target server by design.
- Terminal input/output buffers are read-modify-write in the database (not atomic): under a race a keystroke can be lost or replayed on the owner's own server. Integrity only, no cross-account impact.
- The install one-liner puts the token in the shell history of the machine where it is pasted; clear it afterwards (history -d) or rotate the token.

## Operator checklist
- Apply all migrations in `supabase/migrations` in order (enable pg_cron first for the retention job). The last one, `explicit_grants`, makes the app work with Supabase's "Automatically expose new tables" turned off.
- Supabase Auth: enable email confirmation, leaked-password protection, min password length 10, CAPTCHA (Turnstile secret), and add the production URL to redirect URLs.
- Set `VITE_TURNSTILE_SITE_KEY` in the host environment.
- Never prefix secrets with `VITE_`.
