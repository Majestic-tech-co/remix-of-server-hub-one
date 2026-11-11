import { supabase } from "@/integrations/supabase/client";

// Columns the browser may read from `servers`. The token hash is deliberately excluded
// (column-level privileges in the database enforce this too), so never use select("*").
export const SERVER_COLUMNS =
  "id,user_id,name,hostname,ip_address,os,tags,last_seen_at,created_at,type,region,instance_id,connection_notes";

export function buildInstallCommand(token: string): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `curl -fsSL ${origin}/api/agent/install | sudo FLEET_TOKEN=${token} FLEET_URL=${origin} bash`;
}

export function buildUninstallCommand(): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `curl -fsSL ${origin}/api/agent/uninstall | sudo bash`;
}

/** POST JSON to our own API with the signed-in user's access token. */
export async function authedPost<T>(path: string, body: unknown): Promise<{ data?: T; error?: string }> {
  const { data: s } = await supabase.auth.getSession();
  const token = s.session?.access_token;
  if (!token) return { error: "Your session has expired. Please sign in again." };
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { error: typeof json?.error === "string" ? json.error : "Something went wrong. Please try again." };
    return { data: json as T };
  } catch {
    return { error: "Network problem. Check your connection and try again." };
  }
}
