// POST /api/desktop/download   (signed-in users only)
//   { action: "info" }  -> { version, name, size }          what the newest installer is
//   { action: "link" }  -> { version, name, size, url }     a short-lived link that downloads it
//
// Installers live as PRIVATE GitHub release assets. This route uses a read-only GitHub token (kept in
// Vercel, never sent to the browser) to ask GitHub for a signed download link that expires in minutes.
// Setup: create a fine-grained GitHub token with read-only "Contents" access to this repository and set
// GITHUB_RELEASES_TOKEN (and optionally GITHUB_REPO="owner/name") in the Vercel project.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { getUserFromRequest } from "@/integrations/supabase/route-auth";
import { isSafeDownloadUrl, pickLatestInstaller, type GhRelease, type LatestInstaller } from "@/lib/desktopRelease.server";
import { errors, json, logServerError, rateLimit } from "@/lib/security.server";

const Schema = z.object({ action: z.enum(["info", "link"]) }).strict();

const REPO = process.env.GITHUB_REPO ?? "Majestic-tech-co/remix-of-server-hub-one";
const GH = { "User-Agent": "fleet-site", "X-GitHub-Api-Version": "2022-11-28" };
const CACHE_MS = 60_000;
let cache: { at: number; latest: LatestInstaller | null } | null = null;

async function latestInstaller(token: string): Promise<LatestInstaller | null> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.latest;
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=30`, {
    headers: { ...GH, Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`GitHub releases request failed: ${res.status}`);
  const latest = pickLatestInstaller((await res.json()) as GhRelease[]);
  cache = { at: Date.now(), latest };
  return latest;
}

export const Route = createFileRoute("/api/desktop/download")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const auth = await getUserFromRequest(request);
          if (auth instanceof Response) return auth;
          const rl = rateLimit(`desktop-dl:${auth.userId}`, 30, 3_600_000);
          if (!rl.ok) return errors.tooMany(rl.retryAfter);

          let body: unknown;
          try { body = await request.json(); } catch { return errors.badRequest(); }
          const parsed = Schema.safeParse(body);
          if (!parsed.success) return errors.badRequest();

          const token = process.env.GITHUB_RELEASES_TOKEN;
          if (!token) return json({ error: "Downloads aren't set up yet." }, 503);

          const latest = await latestInstaller(token);
          if (!latest) return json({ error: "No desktop release has been published yet." }, 404);
          const info = { version: latest.version, name: latest.asset.name, size: latest.asset.size };
          if (parsed.data.action === "info") return json(info);

          // Ask GitHub for the signed download URL (it answers with a redirect we deliberately don't follow).
          const res = await fetch(latest.asset.url, {
            headers: { ...GH, Authorization: `Bearer ${token}`, Accept: "application/octet-stream" },
            redirect: "manual",
            signal: AbortSignal.timeout(8000),
          });
          const location = res.headers.get("location");
          if (res.status < 300 || res.status >= 400 || !isSafeDownloadUrl(location)) {
            logServerError("desktop-download", new Error(`unexpected GitHub response ${res.status}`));
            return errors.server();
          }
          return json({ ...info, url: location });
        } catch (e) {
          logServerError("desktop-download", e);
          return errors.server();
        }
      },
    },
  },
});
