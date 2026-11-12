// POST /api/agent/metrics
// Headers: X-Fleet-Token: <agent_token>
// Body: { hostname, ip, os, cpu_percent, memory_percent, memory_used_mb, memory_total_mb,
//         disk_percent, disk_used_gb, disk_total_gb, net_rx_kbs, net_tx_kbs, load_1, uptime_seconds }
// Response: { ok: true, pending_commands: [{ id, command }] }
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { z } from "zod";
import { authenticateAgent, errors, json, logServerError } from "@/lib/security.server";

const Schema = z.object({
  hostname: z.string().max(255).optional(),
  ip: z.string().max(64).optional(),
  os: z.string().max(255).optional(),
  cpu_percent: z.number().min(0).max(100).optional(),
  memory_percent: z.number().min(0).max(100).optional(),
  memory_used_mb: z.number().min(0).optional(),
  memory_total_mb: z.number().min(0).optional(),
  disk_percent: z.number().min(0).max(100).optional(),
  disk_used_gb: z.number().min(0).optional(),
  disk_total_gb: z.number().min(0).optional(),
  net_rx_kbs: z.number().min(0).optional(),
  net_tx_kbs: z.number().min(0).optional(),
  load_1: z.number().min(0).optional(),
  uptime_seconds: z.number().int().min(0).optional(),
});


export const Route = createFileRoute("/api/agent/metrics")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
        const auth = await authenticateAgent(request, supabaseAdmin, { limit: 40 });
        if (auth instanceof Response) return auth;
        const srv = { id: auth.serverId };

        let body: unknown;
        try { body = await request.json(); } catch { return errors.badRequest(); }
        const parsed = Schema.safeParse(body);
        if (!parsed.success) return errors.badRequest();
        const data = parsed.data;

        // A commands-only poll (?commands_only=1) skips inventory + metric writes so the agent
        // can check for work every few seconds without bloating the metrics table.
        const commandsOnly = new URL(request.url).searchParams.get("commands_only") === "1";
        if (!commandsOnly) {
        // Update server inventory + last_seen
          const updates: {
            last_seen_at: string;
            hostname?: string;
            ip_address?: string;
            os?: string;
          } = { last_seen_at: new Date().toISOString() };
          if (data.hostname) updates.hostname = data.hostname;
          if (data.ip) updates.ip_address = data.ip;
          if (data.os) updates.os = data.os;
          await supabaseAdmin.from("servers").update(updates).eq("id", srv.id);
  
          // Insert metric
          await supabaseAdmin.from("metrics").insert({
            server_id: srv.id,
            cpu_percent: data.cpu_percent ?? null,
            memory_percent: data.memory_percent ?? null,
            memory_used_mb: data.memory_used_mb ?? null,
            memory_total_mb: data.memory_total_mb ?? null,
            disk_percent: data.disk_percent ?? null,
            disk_used_gb: data.disk_used_gb ?? null,
            disk_total_gb: data.disk_total_gb ?? null,
            net_rx_kbs: data.net_rx_kbs ?? null,
            net_tx_kbs: data.net_tx_kbs ?? null,
            load_1: data.load_1 ?? null,
            uptime_seconds: data.uptime_seconds ?? null,
          });
        }

        // Claim pending commands: ONE atomic database call. A server switched to monitoring-only
        // (remote_access = false) is handed nothing, no matter what is queued for it.
        const { data: claimed, error: claimErr } = await supabaseAdmin.rpc("claim_commands", { p_server: srv.id, p_limit: 5 });
        if (claimErr) throw claimErr;
        const pending = (claimed ?? []) as { id: string; command: string }[];

        return json({ ok: true, pending_commands: pending ?? [] });
        } catch (e) {
          logServerError("metrics", e);
          return errors.server();
        }
      },
    },
  },
});
