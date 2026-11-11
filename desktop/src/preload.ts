// Runs in the page's isolated preload context. It exposes a small, fixed API as `window.fleetDesktop`.
// The page never gets `ipcRenderer`, Node, or any way to read stored secrets.
import { contextBridge, ipcRenderer } from "electron";

type Result<T extends object = object> =
  | ({ ok: true } & T)
  | { ok: false; code: string; message: string; detail?: Record<string, string> };

const invoke = <T extends object = object>(channel: string, input?: unknown) =>
  ipcRenderer.invoke(channel, input) as Promise<Result<T>>;

interface PublicProfile {
  host: string;
  port: number;
  username: string;
  authType: "password" | "key";
  hasSecret: boolean;
  trustedFingerprint: string | null;
}

const appVersion = process.argv.find((a) => a.startsWith("--fleet-app-version="))?.split("=")[1] ?? "unknown";

contextBridge.exposeInMainWorld("fleetDesktop", {
  version: 1,        // bridge API version
  appVersion,        // installed app version, e.g. "0.1.0"
  profiles: {
    get: (serverId: string) => invoke<{ profile: PublicProfile | null }>("profiles:get", { serverId }),
    save: (input: Record<string, unknown>) => invoke<{ profile: PublicProfile | null }>("profiles:save", input),
    importKey: (serverId: string) => invoke<{ imported: boolean; encrypted: boolean }>("profiles:importKey", { serverId }),
    remove: (serverId: string) => invoke("profiles:remove", { serverId }),
    forgetHostKey: (serverId: string) => invoke("profiles:forgetHostKey", { serverId }),
  },
  ssh: {
    connect: (serverId: string, cols: number, rows: number) => invoke<{ sessionId: string }>("ssh:connect", { serverId, cols, rows }),
    trust: (serverId: string, fingerprint: string) => invoke("ssh:trust", { serverId, fingerprint }),
    write: (sessionId: string, data: string) => ipcRenderer.send("ssh:write", { sessionId, data }),
    resize: (sessionId: string, cols: number, rows: number) => ipcRenderer.send("ssh:resize", { sessionId, cols, rows }),
    close: (sessionId: string) => invoke("ssh:close", { sessionId }),
    onData: (cb: (sessionId: string, data: Uint8Array) => void) => {
      const h = (_e: unknown, id: string, data: Uint8Array) => cb(id, data);
      ipcRenderer.on("ssh:data", h);
      return () => { ipcRenderer.removeListener("ssh:data", h); };
    },
    onClose: (cb: (sessionId: string, reason: string) => void) => {
      const h = (_e: unknown, id: string, reason: string) => cb(id, reason);
      ipcRenderer.on("ssh:close", h);
      return () => { ipcRenderer.removeListener("ssh:close", h); };
    },
  },
});
