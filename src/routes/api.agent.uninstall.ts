// GET /api/agent/uninstall — returns the bash uninstaller
import { createFileRoute } from "@tanstack/react-router";
import script from "@/agent/uninstall.sh?raw";
import { clientIp, errors, rateLimit } from "@/lib/security.server";

export const Route = createFileRoute("/api/agent/uninstall")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const rl = rateLimit(`uninstall:${clientIp(request)}`, 30, 60_000);
        if (!rl.ok) return errors.tooMany(rl.retryAfter);
        return new Response(script, {
          status: 200,
          headers: {
            "Content-Type": "text/x-shellscript; charset=utf-8",
            "Cache-Control": "no-store",
          },
        });
      },
    },
  },
});
