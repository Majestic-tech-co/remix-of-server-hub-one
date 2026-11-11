// Small, dependency-free security helpers shared by the main process and tests.
import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * The Fleet app loads the Fleet website. Only that exact origin may use the SSH bridge or navigate
 * the window. https is required, except http://localhost for development builds.
 */
export function isAllowedOrigin(url: string | undefined | null, allowed: string, opts: { dev?: boolean } = {}): boolean {
  if (!url) return false;
  let u: URL;
  let a: URL;
  try {
    u = new URL(url);
    a = new URL(allowed);
  } catch {
    return false;
  }
  const schemeOk = u.protocol === "https:" || (!!opts.dev && u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1"));
  return schemeOk && u.origin === a.origin;
}

/** OpenSSH-style SHA256 fingerprint of an SSH public key blob, e.g. "SHA256:abc…" (no padding). */
export function fingerprintSha256(publicKeyBlob: Buffer): string {
  return "SHA256:" + createHash("sha256").update(publicKeyBlob).digest("base64").replace(/=+$/, "");
}

export const uuid = z.string().uuid();

export const ProfileInput = z.object({
  host: z.string().trim().min(1).max(253).regex(/^[A-Za-z0-9._:-]+$/, "invalid host"),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._@-]+$/, "invalid username"),
  authType: z.enum(["password", "key"]),
  // Secrets are optional so the user can edit host/port without retyping them.
  password: z.string().min(1).max(1024).optional(),
  passphrase: z.string().max(1024).optional(),
}).strict();
export type ProfileInput = z.infer<typeof ProfileInput>;

export const ConnectInput = z.object({
  serverId: uuid,
  cols: z.number().int().min(20).max(500),
  rows: z.number().int().min(5).max(200),
}).strict();

export const WriteInput = z.object({ sessionId: z.string().min(8).max(64), data: z.string().max(1_000_000) }).strict();
export const ResizeInput = z.object({
  sessionId: z.string().min(8).max(64),
  cols: z.number().int().min(20).max(500),
  rows: z.number().int().min(5).max(200),
}).strict();
export const SessionInput = z.object({ sessionId: z.string().min(8).max(64) }).strict();
export const TrustInput = z.object({ serverId: uuid, fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/) }).strict();
