// Test helpers: a real in-process SSH server and a fake keychain. Not used by the app itself.
import { timingSafeEqual } from "node:crypto";
import { Server, utils } from "ssh2";
import type { SecretBox } from "./store";

export const USER = "alice";
export const PASSWORD = "correct horse battery staple";

export function newKeyPair(passphrase?: string) {
  return utils.generateKeyPairSync("ed25519", passphrase ? { passphrase, cipher: "aes256-cbc", rounds: 16 } : undefined);
}

export interface TestServer {
  port: number;
  resizes: { cols: number; rows: number }[];
  received: string[];
  connections: number;
  close: () => Promise<void>;
  /** abruptly end every connected client (simulates the server or network dying) */
  dropAll: () => void;
}

/** An SSH server that accepts one password and/or one public key, and echoes whatever you type. */
export async function startServer(opts: { hostKey: string; authorizedKey?: string; port?: number }): Promise<TestServer> {
  const resizes: { cols: number; rows: number }[] = [];
  const received: string[] = [];
  const state = { connections: 0 };
  const clients = new Set<{ end(): void }>();
  const allowed = opts.authorizedKey ? utils.parseKey(opts.authorizedKey) : null;

  const server = new Server({ hostKeys: [opts.hostKey] }, (client) => {
    state.connections++;
    clients.add(client);
    client.on("close", () => clients.delete(client));
    client.on("authentication", (ctx) => {
      if (ctx.username !== USER) return ctx.reject();
      if (ctx.method === "password" && ctx.password === PASSWORD) return ctx.accept();
      if (ctx.method === "publickey" && allowed && !(allowed instanceof Error)) {
        const a = Array.isArray(allowed) ? allowed[0] : allowed;
        const ok = ctx.key.algo === a.type && timingSafeEqual(ctx.key.data, a.getPublicSSH());
        if (!ok) return ctx.reject();
        if (ctx.signature && !a.verify(ctx.blob!, ctx.signature, ctx.hashAlgo)) return ctx.reject();
        return ctx.accept();
      }
      return ctx.reject();
    });
    client.on("error", () => { /* clients disconnecting abruptly is normal in tests */ });
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("pty", (acc) => acc && acc());
        session.on("window-change", (acc, _rej, info) => {
          resizes.push({ cols: info.cols, rows: info.rows });
          acc && acc();
        });
        session.on("shell", (acc) => {
          const stream = acc();
          stream.write("welcome\r\n");
          stream.on("data", (d: Buffer) => {
            received.push(d.toString());
            stream.write(d); // echo
          });
        });
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    resizes,
    received,
    get connections() { return state.connections; },
    dropAll: () => { for (const c of clients) c.end(); },
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); for (const c of clients) c.end(); }),
  } as TestServer;
}

/** Reversible but non-plaintext "encryption", so tests can prove secrets aren't stored in the clear. */
export const fakeBox = (available = true): SecretBox => ({
  available: () => available,
  encrypt: (plain) => Buffer.from(Buffer.from(plain).map((b) => b ^ 0x5a)),
  decrypt: (data) => Buffer.from(Buffer.from(data).map((b) => b ^ 0x5a)).toString(),
});

export async function until(cond: () => boolean, ms = 4000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 15));
  }
}
