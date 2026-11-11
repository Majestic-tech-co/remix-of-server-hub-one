// Detection and types for the Fleet desktop app. Inside the app, the preload script exposes
// `window.fleetDesktop`; in a normal browser it does not exist and none of this UI appears.
import { useEffect, useState } from "react";

export interface DesktopProfile {
  host: string;
  port: number;
  username: string;
  authType: "password" | "key";
  hasSecret: boolean;
  trustedFingerprint: string | null;
}

export type DesktopResult<T extends object = object> =
  | ({ ok: true } & T)
  | { ok: false; code: string; message: string; detail?: Record<string, string> };

export interface FleetDesktop {
  version: number;
  /** Installed app version, e.g. "0.1.0". */
  appVersion?: string;
  profiles: {
    get(serverId: string): Promise<DesktopResult<{ profile: DesktopProfile | null }>>;
    save(input: {
      serverId: string;
      host: string;
      port: number;
      username: string;
      authType: "password" | "key";
      password?: string;
      passphrase?: string;
    }): Promise<DesktopResult<{ profile: DesktopProfile | null }>>;
    importKey(serverId: string): Promise<DesktopResult<{ imported: boolean; encrypted: boolean }>>;
    remove(serverId: string): Promise<DesktopResult>;
    forgetHostKey(serverId: string): Promise<DesktopResult>;
  };
  ssh: {
    connect(serverId: string, cols: number, rows: number): Promise<DesktopResult<{ sessionId: string }>>;
    trust(serverId: string, fingerprint: string): Promise<DesktopResult>;
    write(sessionId: string, data: string): void;
    resize(sessionId: string, cols: number, rows: number): void;
    close(sessionId: string): Promise<DesktopResult>;
    onData(cb: (sessionId: string, data: Uint8Array) => void): () => void;
    onClose(cb: (sessionId: string, reason: string) => void): () => void;
  };
}

declare global {
  interface Window {
    fleetDesktop?: FleetDesktop;
  }
}

/** The desktop bridge if (and only if) we're running inside the Fleet app. */
export function getDesktop(): FleetDesktop | null {
  if (typeof window === "undefined") return null;
  const d = window.fleetDesktop;
  return d && d.version === 1 && typeof d.ssh?.connect === "function" ? d : null;
}

/** Safe for server rendering: false on the server and on first render, then true inside the app. */
export function useDesktop(): FleetDesktop | null {
  const [desktop, setDesktop] = useState<FleetDesktop | null>(null);
  useEffect(() => setDesktop(getDesktop()), []);
  return desktop;
}
