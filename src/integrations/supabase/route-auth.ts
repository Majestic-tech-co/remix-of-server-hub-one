// Helper for server *routes* (not server functions) that need to authenticate
// the calling browser user. Mirrors the auth-middleware logic used by
// createServerFn but works inside a raw createFileRoute handler.
//
// Returns { userId } on success or a Response (401) on failure that the
// caller can return directly.
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { logServerError, userHasMfa } from "@/lib/security.server";

export async function getUserFromRequest(
  request: Request,
): Promise<{ userId: string } | Response> {
  const authHeader = request.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !anon) {
    return new Response(JSON.stringify({ error: "server misconfigured" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const sb = createClient(url, anon, {
    auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await sb.auth.getClaims(token);
  if (error || !data?.claims?.sub) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  // Reject anonymous sessions (if anonymous sign-ins are ever enabled in Supabase).
  if ((data.claims as { is_anonymous?: boolean }).is_anonymous) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  const userId = data.claims.sub as string;

  // Two-factor: a user who has set it up must present an aal2 session (a code was entered).
  // Otherwise a stolen password alone could call this API directly and skip the code prompt.
  if ((data.claims as { aal?: string }).aal !== "aal2") {
    try {
      if (await userHasMfa(supabaseAdmin, userId)) {
        return new Response(JSON.stringify({ error: "Two-factor verification required.", code: "mfa_required" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
    } catch (e) {
      logServerError("mfa-check", e); // fail closed: if we can't tell, don't let a password-only session through
      return new Response(JSON.stringify({ error: "Something went wrong. Please try again." }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }
  return { userId };
}
