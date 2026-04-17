// GET /api/agent/install — returns the bash installer
import { createFileRoute } from "@tanstack/react-router";
import script from "@/agent/install.sh?raw";

export const Route = createFileRoute("/api/agent/install")({
  server: {
    handlers: {
      GET: async () => {
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
