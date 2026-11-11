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

## Known risks
- CSP allows `'unsafe-inline'` scripts (TanStack Start inline hydration). Move to nonces when supported.
- In-memory rate limiter is per instance; add a WAF/Redis limiter for strict global limits.
- `agent_token` stored in plaintext and readable by its owner (needed to show the install command).
- The agent and terminal run as root on the target server by design.

## Operator checklist
- Apply `supabase/migrations/20261110000000_security_hardening.sql`.
- Supabase Auth: enable email confirmation, leaked-password protection, min password length 10, CAPTCHA (Turnstile secret), and add the production URL to redirect URLs.
- Set `VITE_TURNSTILE_SITE_KEY` in the host environment.
- Never prefix secrets with `VITE_`.
