// Per-device storage for SSH connection profiles, secrets and trusted host keys.
//
// Secrets (password / private key / passphrase) are encrypted with the operating system's keychain
// (Electron safeStorage: DPAPI on Windows, Keychain on macOS, libsecret on Linux). They are NEVER
// written in plain text, never sent to Fleet's servers, and never returned to the web page: the page
// can save a secret and ask whether one exists, but cannot read it back.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { uuid } from "./security";

/** Encryption backend. In the app this is Electron's safeStorage; tests pass a fake. */
export interface SecretBox {
  available(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(data: Buffer): string;
}

export type AuthType = "password" | "key";
export interface ProfileMeta {
  host: string;
  port: number;
  username: string;
  authType: AuthType;
}
export interface Secrets {
  password?: string;
  privateKey?: string;
  passphrase?: string;
}
/** What the web page is allowed to see about a profile. */
export interface PublicProfile extends ProfileMeta {
  hasSecret: boolean;
  trustedFingerprint: string | null;
}

interface FileShape {
  version: 1;
  profiles: Record<string, ProfileMeta & { secret?: string }>;
  hostKeys: Record<string, string>;
}

export class StoreError extends Error {
  constructor(public code: "NO_KEYCHAIN" | "BAD_ID", message: string) {
    super(message);
  }
}

export class ProfileStore {
  constructor(private file: string, private box: SecretBox) {}

  private read(): FileShape {
    if (!existsSync(this.file)) return { version: 1, profiles: {}, hostKeys: {} };
    try {
      const j = JSON.parse(readFileSync(this.file, "utf8")) as FileShape;
      return { version: 1, profiles: j.profiles ?? {}, hostKeys: j.hostKeys ?? {} };
    } catch {
      // Corrupt file: don't crash the app; start empty (the old file is replaced on next write).
      return { version: 1, profiles: {}, hostKeys: {} };
    }
  }

  private write(data: FileShape): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file); // atomic: a crash never leaves a half-written file
    try { chmodSync(this.file, 0o600); } catch { /* not supported on Windows */ }
  }

  private id(serverId: string): string {
    if (!uuid.safeParse(serverId).success) throw new StoreError("BAD_ID", "invalid server id");
    return serverId;
  }

  getProfile(serverId: string): PublicProfile | null {
    const d = this.read();
    const p = d.profiles[this.id(serverId)];
    if (!p) return null;
    return {
      host: p.host,
      port: p.port,
      username: p.username,
      authType: p.authType,
      hasSecret: !!p.secret,
      trustedFingerprint: d.hostKeys[serverId] ?? null,
    };
  }

  /** Save connection details. Secrets, when given, replace the stored ones; omitted ones are kept. */
  saveProfile(serverId: string, meta: ProfileMeta, secrets: Secrets = {}): void {
    this.id(serverId);
    const d = this.read();
    const prev = d.profiles[serverId];
    let secret = prev?.secret;
    const hasNew = secrets.password !== undefined || secrets.privateKey !== undefined || secrets.passphrase !== undefined;
    if (hasNew) {
      if (!this.box.available()) {
        throw new StoreError("NO_KEYCHAIN", "Secure storage is not available on this computer, so credentials can't be saved safely.");
      }
      const merged: Secrets = { ...(prev?.secret ? this.decode(prev.secret) : {}), ...stripUndefined(secrets) };
      // switching auth type drops the other type's secret
      if (meta.authType === "password") { delete merged.privateKey; delete merged.passphrase; }
      if (meta.authType === "key") delete merged.password;
      secret = this.box.encrypt(JSON.stringify(merged)).toString("base64");
    } else if (prev && prev.authType !== meta.authType) {
      secret = undefined; // changed method without supplying a new secret: old one no longer applies
    }
    // host or user changed: the saved host key no longer vouches for the new target
    if (prev && (prev.host !== meta.host || prev.port !== meta.port)) delete d.hostKeys[serverId];
    d.profiles[serverId] = { ...meta, ...(secret ? { secret } : {}) };
    this.write(d);
  }

  /** For the main process only. */
  getSecrets(serverId: string): Secrets | null {
    const p = this.read().profiles[this.id(serverId)];
    if (!p?.secret) return null;
    return this.decode(p.secret);
  }

  private decode(b64: string): Secrets {
    return JSON.parse(this.box.decrypt(Buffer.from(b64, "base64"))) as Secrets;
  }

  removeProfile(serverId: string): void {
    const d = this.read();
    delete d.profiles[this.id(serverId)];
    delete d.hostKeys[serverId];
    this.write(d);
  }

  getHostKey(serverId: string): string | null {
    return this.read().hostKeys[this.id(serverId)] ?? null;
  }
  setHostKey(serverId: string, fingerprint: string): void {
    const d = this.read();
    d.hostKeys[this.id(serverId)] = fingerprint;
    this.write(d);
  }
  forgetHostKey(serverId: string): void {
    const d = this.read();
    delete d.hostKeys[this.id(serverId)];
    this.write(d);
  }
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
