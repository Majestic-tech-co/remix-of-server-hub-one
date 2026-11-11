// The bridge API between the Fleet web page and this computer's SSH + keychain.
//
// Framework-free so it can be unit-tested. The Electron main process wires each method to an IPC
// channel. EVERY call:
//   1. must come from the top frame of a page on the exact Fleet origin (isAllowedOrigin),
//   2. has its input validated with a strict schema,
//   3. returns a plain result object whose errors are friendly and contain no secrets.
// Secrets (passwords, private keys) can be saved but never read back by the page.
import { utils } from "ssh2";
import { z } from "zod";
import {
  ConnectInput, isAllowedOrigin, ProfileInput, ResizeInput, SessionInput, TrustInput, uuid, WriteInput,
} from "./security";
import { SshError, type SshManager } from "./ssh";
import { type ProfileStore, StoreError } from "./store";

export interface Ctx {
  /** Electron webContents id of the calling window. */
  owner: number;
  /** URL of the frame that made the call. */
  url: string | undefined;
  isMainFrame: boolean;
}

export interface ApiDeps {
  store: ProfileStore;
  ssh: SshManager;
  allowedOrigin: string;
  dev?: boolean;
  /** Show a file picker and return the chosen file's text, or null if cancelled. Runs in the main process. */
  pickKeyFile: () => Promise<{ name: string; text: string } | null>;
}

export type Result<T extends object = object> =
  | ({ ok: true } & T)
  | { ok: false; code: string; message: string; detail?: Record<string, string> };

class ApiError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

const Id = z.object({ serverId: uuid }).strict();
const SaveInput = ProfileInput.extend({ serverId: uuid }).strict();

const MAX_KEY_BYTES = 100_000;

export function createApi(deps: ApiDeps) {
  const { store, ssh } = deps;

  async function run<T extends object>(ctx: Ctx, fn: () => T | Promise<T>): Promise<Result<T>> {
    try {
      if (!ctx.isMainFrame || !isAllowedOrigin(ctx.url, deps.allowedOrigin, { dev: deps.dev })) {
        throw new ApiError("FORBIDDEN", "This page isn't allowed to use SSH.");
      }
      return { ok: true, ...(await fn()) };
    } catch (e) {
      return toError(e);
    }
  }

  return {
    profileGet: (ctx: Ctx, input: unknown) =>
      run(ctx, () => ({ profile: store.getProfile(Id.parse(input).serverId) })),

    profileSave: (ctx: Ctx, input: unknown) =>
      run(ctx, () => {
        const { serverId, password, passphrase, ...meta } = SaveInput.parse(input);
        store.saveProfile(serverId, meta, {
          ...(password !== undefined ? { password } : {}),
          ...(passphrase !== undefined ? { passphrase } : {}),
        });
        return { profile: store.getProfile(serverId) };
      }),

    /** The key file is chosen and read in the main process: the page never sees its contents. */
    profileImportKey: (ctx: Ctx, input: unknown) =>
      run(ctx, async () => {
        const { serverId } = Id.parse(input);
        const profile = store.getProfile(serverId);
        if (!profile) throw new ApiError("NO_PROFILE", "Save the connection details first, then choose the key.");
        if (profile.authType !== "key") throw new ApiError("BAD_INPUT", "This connection uses a password, not a key.");
        const file = await deps.pickKeyFile();
        if (!file) return { imported: false, encrypted: false };
        if (Buffer.byteLength(file.text) > MAX_KEY_BYTES) throw new ApiError("BAD_KEY", "That file is too large to be a private key.");
        const parsed = utils.parseKey(file.text);
        let encrypted = false;
        if (parsed instanceof Error) {
          if (/passphrase/i.test(parsed.message)) encrypted = true; // passphrase-protected: fine, user supplies it
          else throw new ApiError("BAD_KEY", "That doesn't look like a private key file.");
        } else {
          const key = Array.isArray(parsed) ? parsed[0] : parsed;
          if (!key.isPrivateKey()) throw new ApiError("BAD_KEY", "That's a public key. Choose the private key file (usually without .pub).");
        }
        const { host, port, username, authType } = profile;
        store.saveProfile(serverId, { host, port, username, authType }, { privateKey: file.text });
        return { imported: true, encrypted };
      }),

    profileRemove: (ctx: Ctx, input: unknown) =>
      run(ctx, () => {
        store.removeProfile(Id.parse(input).serverId);
        return {};
      }),

    /** Deliberately forget a pinned host key, e.g. after reinstalling the server. */
    forgetHostKey: (ctx: Ctx, input: unknown) =>
      run(ctx, () => {
        store.forgetHostKey(Id.parse(input).serverId);
        return {};
      }),

    sshConnect: (ctx: Ctx, input: unknown) =>
      run(ctx, async () => {
        const { serverId, cols, rows } = ConnectInput.parse(input);
        return ssh.connect(serverId, cols, rows, ctx.owner);
      }),

    sshTrust: (ctx: Ctx, input: unknown) =>
      run(ctx, () => {
        const { serverId, fingerprint } = TrustInput.parse(input);
        ssh.trustHostKey(serverId, fingerprint);
        return {};
      }),

    sshWrite: (ctx: Ctx, input: unknown) =>
      run(ctx, () => {
        const { sessionId, data } = WriteInput.parse(input);
        ssh.write(sessionId, ctx.owner, data);
        return {};
      }),

    sshResize: (ctx: Ctx, input: unknown) =>
      run(ctx, () => {
        const { sessionId, cols, rows } = ResizeInput.parse(input);
        ssh.resize(sessionId, ctx.owner, cols, rows);
        return {};
      }),

    sshClose: (ctx: Ctx, input: unknown) =>
      run(ctx, () => {
        const { sessionId } = SessionInput.parse(input);
        ssh.close(sessionId, ctx.owner);
        return {};
      }),
  };
}

export type Api = ReturnType<typeof createApi>;

function toError(e: unknown): Result<never> {
  if (e instanceof SshError) return { ok: false, code: e.code, message: e.message, ...(e.detail ? { detail: e.detail } : {}) };
  if (e instanceof StoreError) return { ok: false, code: e.code, message: e.message };
  if (e instanceof ApiError) return { ok: false, code: e.code, message: e.message };
  if (e instanceof z.ZodError) return { ok: false, code: "BAD_INPUT", message: "Invalid input." }; // never echo the values
  return { ok: false, code: "INTERNAL", message: "Something went wrong." };
}
