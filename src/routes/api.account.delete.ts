// POST /api/account/delete
// Browser auth (Bearer JWT). Permanently deletes the caller's account and all their data.
// The caller must type their own email address as confirmation.
// Everything cascades from auth.users (servers → metrics/commands/terminal sessions, playbooks, runs, logs).
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getUserFromRequest } from "@/integrations/supabase/route-auth";
import { errors, json, logServerError, rateLimit } from "@/lib/security.server";

const Schema = z.object({ confirm_email: z.string().trim().min(3).max(254) }).strict();

export const Route = createFileRoute("/api/account/delete")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const auth = await getUserFromRequest(request);
          if (auth instanceof Response) return auth;
          const rl = rateLimit(`account-delete:${auth.userId}`, 3, 3_600_000);
          if (!rl.ok) return errors.tooMany(rl.retryAfter);

          let body: unknown;
          try { body = await request.json(); } catch { return errors.badRequest(); }
          const parsed = Schema.safeParse(body);
          if (!parsed.success) return errors.badRequest();

          const { data: u, error: getErr } = await supabaseAdmin.auth.admin.getUserById(auth.userId);
          if (getErr || !u.user) {
            if (getErr) logServerError("account-delete", getErr);
            return errors.notFound();
          }
          if ((u.user.email ?? "").toLowerCase() !== parsed.data.confirm_email.toLowerCase()) {
            return json({ error: "The email you typed doesn't match this account." }, 400);
          }

          const { error } = await supabaseAdmin.auth.admin.deleteUser(auth.userId);
          if (error) {
            logServerError("account-delete", error);
            return errors.server();
          }
          return json({ ok: true });
        } catch (e) {
          logServerError("account-delete", e);
          return errors.server();
        }
      },
    },
  },
});
