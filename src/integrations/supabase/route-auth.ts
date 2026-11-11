// Helper for server *routes* (not server functions) that need to authenticate
// the calling browser user. Mirrors the auth-middleware logic used by
// createServerFn but works inside a raw createFileRoute handler.
//
// Returns { userId } on success or a Response (401) on failure that the
// caller can return directly.
import { createClient } from "@supabase/supabase-js";

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
  return { userId: data.claims.sub as string };
}
