// Server-only security helpers: security headers, rate limiting, safe responses.
// Imported only from server handlers / middleware.

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "";

function supabaseOrigins(): { http: string; ws: string } {
  try {
    const u = new URL(SUPABASE_URL);
    return { http: u.origin, ws: `wss://${u.host}` };
  } catch {
    return { http: "https://*.supabase.co", ws: "wss://*.supabase.co" };
  }
}

export function buildSecurityHeaders(): Record<string, string> {
  const sb = supabaseOrigins();
  const isProd = process.env.NODE_ENV === "production";
  // 'unsafe-inline' for scripts is required by TanStack Start's inline SSR
  // hydration payload (known risk, see SECURITY.md). Everything else is locked down.
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    `connect-src 'self' ${sb.http} ${sb.ws}`,
    "frame-src https://challenges.cloudflare.com",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    ...(isProd ? ["upgrade-insecure-requests"] : []),
  ].join("; ");

  return {
    ...(isProd ? { "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload" } : {}),
    "Content-Security-Policy": csp,
        "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Cross-Origin-Opener-Policy": "same-origin",
  };
}

// ---------------------------------------------------------------------------
// Rate limiting (fixed window, in-memory).
// Best-effort: state is per server instance/isolate. It stops casual abuse and
// runaway agents; for strict global limits add a Cloudflare/Vercel WAF rule or
// a shared store (e.g. Upstash Redis) behind this same function.
// ---------------------------------------------------------------------------
type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();
let lastSweep = 0;

export function rateLimit(key: string, limit: number, windowMs: number): { ok: boolean; retryAfter: number } {
  const now = Date.now();
  if (now - lastSweep > 60_000) {
    lastSweep = now;
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
    if (buckets.size > 50_000) buckets.clear(); // hard memory cap
  }
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfter: 0 };
  }
  b.count += 1;
  if (b.count > limit) return { ok: false, retryAfter: Math.ceil((b.resetAt - now) / 1000) };
  return { ok: true, retryAfter: 0 };
}

/**
 * Client IP for rate limiting. Only headers that the hosting platform itself sets and
 * overwrites are trusted. Vercel sets x-vercel-forwarded-for / x-real-ip and replaces any
 * client-supplied value. We deliberately do NOT trust cf-connecting-ip: with no Cloudflare
 * proxy in front, any caller could forge it to get a fresh rate-limit bucket on every request.
 * If you later put Cloudflare in front of the site, trust cf-connecting-ip only then.
 */
export function clientIp(request: Request): string {
  return (
    request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 192-bit random token, hex encoded. Shown once, only its hash is stored. */
export function generateAgentToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Small stable hash so raw tokens never become map keys / log lines.
export function shortHash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// ---------------------------------------------------------------------------
// Responses. No CORS headers on purpose: the API is only called same-origin by
// the browser UI, or by non-browser agents (curl/python) that ignore CORS.
// ---------------------------------------------------------------------------
export function json(body: unknown, status = 200, extra?: HeadersInit): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...extra } });
}

export const errors = {
  unauthorized: () => json({ error: "Unauthorized" }, 401),
  notFound: () => json({ error: "Not found" }, 404),
  badRequest: () => json({ error: "Invalid request" }, 400),
  server: () => json({ error: "Something went wrong. Please try again." }, 500),
  tooMany: (retryAfter: number) =>
    json({ error: "Too many requests. Please slow down." }, 429, { "Retry-After": String(retryAfter) }),
};

/** Log full detail server-side only; never return it to the client. */
export function logServerError(scope: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : typeof err === "object" ? JSON.stringify(err) : String(err);
  console.error(`[${scope}] ${msg}`);
}

// ---------------------------------------------------------------------------
// Workspace roles. Server routes use the service role (which bypasses row-level security),
// so every route MUST check the caller's role here before acting.
// ---------------------------------------------------------------------------
export type WorkspaceRole = "viewer" | "member" | "admin" | "owner";
const ROLE_RANK: Record<WorkspaceRole, number> = { viewer: 1, member: 2, admin: 3, owner: 4 };

export function roleAtLeast(role: string | null | undefined, min: WorkspaceRole): boolean {
  return !!role && role in ROLE_RANK && ROLE_RANK[role as WorkspaceRole] >= ROLE_RANK[min];
}

export async function getRole(
  admin: { from: (t: "workspace_members") => any },
  userId: string,
  workspaceId: string,
): Promise<WorkspaceRole | null> {
  const { data } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .maybeSingle();
  return (data?.role as WorkspaceRole | undefined) ?? null;
}

/** Which workspace a server belongs to, and what role the caller has there. null = no such server. */
export async function getServerAccess(
  admin: { from: (t: any) => any },
  userId: string,
  serverId: string,
): Promise<{ workspaceId: string; role: WorkspaceRole | null } | null> {
  const { data: s } = await admin.from("servers").select("workspace_id").eq("id", serverId).maybeSingle();
  if (!s) return null;
  return { workspaceId: s.workspace_id as string, role: await getRole(admin, userId, s.workspace_id) };
}

/** Record a user-visible audit event. Never throws: auditing must not break the action itself. */
export async function audit(
  admin: { from: (t: "audit_log") => any },
  userId: string,
  action: string,
  target?: { type: string; id?: string },
  detail: Record<string, unknown> = {},
  workspaceId: string | null = null,
): Promise<void> {
  try {
    const { error } = await admin.from("audit_log").insert({
      user_id: userId,
      workspace_id: workspaceId,
      action,
      target_type: target?.type ?? null,
      target_id: target?.id ?? null,
      detail,
    });
    if (error) logServerError("audit", error);
  } catch (e) {
    logServerError("audit", e);
  }
}

/** Agent-token auth with per-IP throttling of failures. Returns server id or a Response. */
export async function authenticateAgent(
  request: Request,
  admin: { from: (t: "servers") => any },
  opts: { limit: number; windowMs?: number },
): Promise<{ serverId: string } | Response> {
  const ip = clientIp(request);
  const token = request.headers.get("x-fleet-token");
  // Throttle unauthenticated/bad-token traffic by IP first.
  const ipCheck = rateLimit(`agent-ip:${ip}`, 600, 60_000);
  if (!ipCheck.ok) return errors.tooMany(ipCheck.retryAfter);
  if (!token || token.length > 128) return errors.unauthorized();

  const rl = rateLimit(`agent-token:${shortHash(token)}`, opts.limit, opts.windowMs ?? 60_000);
  if (!rl.ok) return errors.tooMany(rl.retryAfter);

  const { data: srv, error } = await admin.from("servers").select("id").eq("agent_token_hash", await sha256Hex(token)).maybeSingle();
  if (error) {
    logServerError("agent-auth", error);
    return errors.server();
  }
  if (!srv) {
    // Penalise bad tokens harder to blunt guessing.
    const bad = rateLimit(`agent-bad:${ip}`, 20, 60_000);
    if (!bad.ok) return errors.tooMany(bad.retryAfter);
    return errors.unauthorized();
  }
  return { serverId: srv.id as string };
}
