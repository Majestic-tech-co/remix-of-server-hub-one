// POST /api/terminal/start
// Browser auth (Bearer token). Body: { server_id, cols, rows }
// Creates a new terminal session and returns its id.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { allowTerminal, audit, errors, getServerAccess, json, logServerError, rateLimit, roleAtLeast } from "@/lib/security.server";
import { getUserFromRequest } from "@/integrations/supabase/route-auth";

const Schema = z.object({
  server_id: z.string().uuid(),
  cols: z.number().int().min(20).max(500).default(80),
  rows: z.number().int().min(5).max(200).default(24),
});


export const Route = createFileRoute("/api/terminal/start")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = await getUserFromRequest(request);
        if (auth instanceof Response) return auth;
        const rl = rateLimit(`term-start:${auth.userId}`, 10, 60_000);
        if (!rl.ok) return errors.tooMany(rl.retryAfter);

        let body: unknown;
        try { body = await request.json(); } catch { return errors.badRequest(); }
        const parsed = Schema.safeParse(body);
        if (!parsed.success) return errors.badRequest();

        // The caller must be a member (or above) of the server's workspace.
        // Non-members get 404 so server IDs in other workspaces are never revealed.
        const access = await getServerAccess(supabaseAdmin, auth.userId, parsed.data.server_id);
        if (!access || !access.role) return errors.notFound();
        if (!roleAtLeast(access.role, "member")) return json({ error: "Viewers can't open terminals." }, 403);
        if (!access.remoteAccess) return json({ error: "Remote access is turned off for this server (monitoring only)." }, 403);
        const srv = { id: parsed.data.server_id };

        // Close any other open sessions for this user+server (one active shell at a time)
        await supabaseAdmin
          .from("terminal_sessions")
          .update({ status: "closed", closed_at: new Date().toISOString() })
          .eq("server_id", srv.id)
          .eq("user_id", auth.userId)
          .in("status", ["requested", "active"]);

        const { data: created, error } = await supabaseAdmin
          .from("terminal_sessions")
          .insert({
            server_id: srv.id,
            user_id: auth.userId,
            cols: parsed.data.cols,
            rows: parsed.data.rows,
            status: "requested",
          })
          .select("id")
          .single();
        if (error || !created) {
          if (error) logServerError("terminal-start", error);
          return errors.server();
        }

        allowTerminal(auth.userId, created.id);
        await audit(supabaseAdmin, auth.userId, "terminal.started", { type: "server", id: parsed.data.server_id }, {}, access.workspaceId);
        return json({ session_id: created.id });
      },
    },
  },
});
