// Direct SSH from this computer to a server, with host-key checking.
//
// Used only by the Electron main process. The web page never sees keys or passwords: it asks main to
// connect by server id, and main loads the saved profile + decrypted secrets from the keychain store.
import { randomBytes } from "node:crypto";
import { Client, type ClientChannel, type ConnectConfig } from "ssh2";
import { fingerprintSha256 } from "./security";
import type { ProfileStore } from "./store";

export type SshErrorCode =
  | "NO_PROFILE"
  | "NO_SECRET"
  | "HOST_KEY_UNKNOWN"
  | "HOST_KEY_CHANGED"
  | "AUTH_FAILED"
  | "REFUSED"
  | "DNS"
  | "TIMEOUT"
  | "TOO_MANY"
  | "NOT_FOUND"
  | "CONNECT_FAILED";

export class SshError extends Error {
  constructor(public code: SshErrorCode, message: string, public detail?: Record<string, string>) {
    super(message);
  }
}

const MESSAGES: Record<SshErrorCode, string> = {
  NO_PROFILE: "No SSH connection is set up for this server yet.",
  NO_SECRET: "No saved password or key for this server. Add one in the connection settings.",
  HOST_KEY_UNKNOWN: "First connection to this server: please verify its fingerprint.",
  HOST_KEY_CHANGED: "WARNING: this server's identity changed since you last connected. This could mean someone is intercepting the connection.",
  AUTH_FAILED: "The server rejected the login. Check the username and password or key.",
  REFUSED: "The server refused the connection. Is SSH running and is the port right?",
  DNS: "Couldn't find that host. Check the address.",
  TIMEOUT: "The connection timed out. The server may be unreachable from here (firewall or VPN?).",
  TOO_MANY: "Too many open SSH sessions. Close one first.",
  NOT_FOUND: "That SSH session doesn't exist.",
  CONNECT_FAILED: "Couldn't connect to the server.",
};

export interface SshEvents {
  /** `owner` is the id of the window that opened the session, so output can be routed back to it. */
  onData: (sessionId: string, data: Buffer, owner: number) => void;
  onClose: (sessionId: string, reason: string, owner: number) => void;
}

interface Session {
  id: string;
  owner: number;
  client: Client;
  stream: ClientChannel;
  closed: boolean;
}

export interface SshOptions {
  maxSessions?: number;
  readyTimeoutMs?: number;
  keepaliveMs?: number;
}

export class SshManager {
  private sessions = new Map<string, Session>();
  /** Fingerprints we've shown the user and that they may now trust (server id → fingerprint). */
  private pending = new Map<string, { fingerprint: string; expires: number }>();
  private maxSessions: number;
  private readyTimeoutMs: number;
  private keepaliveMs: number;

  constructor(private store: ProfileStore, private events: SshEvents, opts: SshOptions = {}) {
    this.maxSessions = opts.maxSessions ?? 10;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 15_000;
    this.keepaliveMs = opts.keepaliveMs ?? 15_000;
  }

  /** Open an interactive shell. `owner` identifies the window that asked (so it can't touch others'). */
  async connect(serverId: string, cols: number, rows: number, owner: number): Promise<{ sessionId: string }> {
    if (this.sessions.size >= this.maxSessions) throw new SshError("TOO_MANY", MESSAGES.TOO_MANY);
    const profile = this.store.getProfile(serverId);
    if (!profile) throw new SshError("NO_PROFILE", MESSAGES.NO_PROFILE);
    const secrets = this.store.getSecrets(serverId);
    if (!secrets || (profile.authType === "password" ? !secrets.password : !secrets.privateKey)) {
      throw new SshError("NO_SECRET", MESSAGES.NO_SECRET);
    }

    const config: ConnectConfig = {
      host: profile.host,
      port: profile.port,
      username: profile.username,
      readyTimeout: this.readyTimeoutMs,
      keepaliveInterval: this.keepaliveMs,
      keepaliveCountMax: 4,
      // Never fall back to an SSH agent or other keys on this computer: only what the user saved.
      agent: undefined,
      tryKeyboard: false,
      ...(profile.authType === "password"
        ? { password: secrets.password }
        : { privateKey: secrets.privateKey, passphrase: secrets.passphrase }),
    };

    const client = new Client();
    let hostKeyProblem: SshError | null = null;

    // Host-key check (trust on first use, then pinned). A mismatch is a hard stop.
    (config as ConnectConfig & { hostVerifier: unknown }).hostVerifier = (key: Buffer) => {
      const fp = fingerprintSha256(key);
      const known = this.store.getHostKey(serverId);
      if (!known) {
        this.pending.set(serverId, { fingerprint: fp, expires: Date.now() + 5 * 60_000 });
        hostKeyProblem = new SshError("HOST_KEY_UNKNOWN", MESSAGES.HOST_KEY_UNKNOWN, { fingerprint: fp });
        return false;
      }
      if (known !== fp) {
        hostKeyProblem = new SshError("HOST_KEY_CHANGED", MESSAGES.HOST_KEY_CHANGED, { expected: known, actual: fp });
        return false;
      }
      return true;
    };

    const stream = await new Promise<ClientChannel>((resolve, reject) => {
      const fail = (e: unknown) => {
        try { client.end(); } catch { /* already closed */ }
        reject(hostKeyProblem ?? classify(e));
      };
      client.once("error", fail);
      client.once("ready", () => {
        client.shell({ term: "xterm-256color", cols, rows }, (err, ch) => {
          if (err || !ch) return fail(err);
          client.removeListener("error", fail);
          resolve(ch);
        });
      });
      try {
        client.connect(config);
      } catch (e) {
        fail(e);
      }
    });

    const id = randomBytes(12).toString("hex");
    const session: Session = { id, owner, client, stream, closed: false };
    this.sessions.set(id, session);

    const finish = (reason: string) => {
      if (session.closed) return;
      session.closed = true;
      this.sessions.delete(id);
      try { client.end(); } catch { /* ignore */ }
      this.events.onClose(id, reason, owner);
    };
    stream.on("data", (d: Buffer) => this.events.onData(id, d, owner));
    stream.stderr.on("data", (d: Buffer) => this.events.onData(id, d, owner));
    stream.on("close", () => finish("closed"));
    client.on("error", () => finish("connection lost"));
    client.on("close", () => finish("closed"));
    return { sessionId: id };
  }

  /** The user has compared the fingerprint and accepts it. Only the one we just showed is accepted. */
  trustHostKey(serverId: string, fingerprint: string): void {
    const p = this.pending.get(serverId);
    if (!p || p.expires < Date.now() || p.fingerprint !== fingerprint) {
      throw new SshError("NOT_FOUND", "That fingerprint isn't the one this app just showed. Try connecting again.");
    }
    this.store.setHostKey(serverId, fingerprint);
    this.pending.delete(serverId);
  }

  private own(sessionId: string, owner: number): Session {
    const s = this.sessions.get(sessionId);
    if (!s || s.owner !== owner) throw new SshError("NOT_FOUND", MESSAGES.NOT_FOUND);
    return s;
  }

  write(sessionId: string, owner: number, data: string): void {
    this.own(sessionId, owner).stream.write(data);
  }
  resize(sessionId: string, owner: number, cols: number, rows: number): void {
    this.own(sessionId, owner).stream.setWindow(rows, cols, 0, 0);
  }
  close(sessionId: string, owner: number): void {
    const s = this.own(sessionId, owner);
    try { s.stream.end(); } catch { /* ignore */ }
    try { s.client.end(); } catch { /* ignore */ }
  }
  /** Close everything a window owns (e.g. when the window closes). */
  closeAllFor(owner: number): void {
    for (const s of [...this.sessions.values()]) if (s.owner === owner) this.close(s.id, owner);
  }
  closeAll(): void {
    for (const s of [...this.sessions.values()]) this.close(s.id, s.owner);
  }
  get openCount(): number {
    return this.sessions.size;
  }
}

/** Turn low-level errors into a small set of friendly, secret-free errors. */
function classify(e: unknown): SshError {
  if (e instanceof SshError) return e;
  const err = e as { code?: string; level?: string; message?: string } | undefined;
  const msg = err?.message ?? "";
  if (err?.code === "ECONNREFUSED") return new SshError("REFUSED", MESSAGES.REFUSED);
  if (err?.code === "ENOTFOUND" || err?.code === "EAI_AGAIN") return new SshError("DNS", MESSAGES.DNS);
  if (err?.code === "ETIMEDOUT" || /timed out/i.test(msg)) return new SshError("TIMEOUT", MESSAGES.TIMEOUT);
  if (err?.level === "client-authentication" || /authentication methods failed/i.test(msg)) {
    return new SshError("AUTH_FAILED", MESSAGES.AUTH_FAILED);
  }
  return new SshError("CONNECT_FAILED", MESSAGES.CONNECT_FAILED);
}
