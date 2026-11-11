import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { toast } from "sonner";
import { AlertTriangle, KeyRound, Loader2, Settings2, ShieldCheck, Terminal as TermIcon, X } from "lucide-react";
import type { DesktopProfile, FleetDesktop } from "@/lib/desktop";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Phase = "loading" | "setup" | "ready" | "connecting" | "connected" | "closed";
type Prompt =
  | { kind: "unknown"; fingerprint: string }
  | { kind: "changed"; expected: string; actual: string }
  | null;

const THEME = {
  background: "#0b0d12", foreground: "#e6e6e6", cursor: "#7dd3a0",
  black: "#1a1d24", red: "#ef6b6b", green: "#7dd3a0", yellow: "#e6c07b", blue: "#79b8ff",
  magenta: "#c792ea", cyan: "#5ccfe6", white: "#d4d4d4",
  brightBlack: "#5c6370", brightRed: "#ff8a8a", brightGreen: "#a8e6c1", brightYellow: "#fadea0",
  brightBlue: "#9bcaff", brightMagenta: "#dab7f5", brightCyan: "#8be9fd", brightWhite: "#ffffff",
};

/** A real SSH terminal that connects straight from this computer to the server (desktop app only). */
export function DesktopSshTerminal({
  desktop,
  serverId,
  serverName,
  defaultHost,
}: {
  desktop: FleetDesktop;
  serverId: string;
  serverName: string;
  defaultHost: string;
}) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [profile, setProfile] = useState<DesktopProfile | null>(null);
  const [prompt, setPrompt] = useState<Prompt>(null);
  const [editing, setEditing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<string | null>(null);

  const loadProfile = useCallback(async () => {
    const r = await desktop.profiles.get(serverId);
    if (!r.ok) { toast.error(r.message); return; }
    setProfile(r.profile);
    setPhase(r.profile && r.profile.hasSecret ? "ready" : "setup");
    setEditing(!r.profile || !r.profile.hasSecret);
  }, [desktop, serverId]);
  useEffect(() => { void loadProfile(); }, [loadProfile]);

  // Close any open session when leaving the page.
  useEffect(() => () => {
    const sid = sessionRef.current;
    if (sid) void desktop.ssh.close(sid);
    termRef.current?.dispose();
    termRef.current = null;
  }, [desktop]);

  const connect = useCallback(async () => {
    setPrompt(null);
    setPhase("connecting");
    // The terminal needs a visible container to measure, so create it before connecting.
    if (!termRef.current && containerRef.current) {
      const term = new XTerm({
        fontFamily: '"JetBrains Mono", ui-monospace, Menlo, monospace', fontSize: 13, lineHeight: 1.25,
        cursorBlink: true, scrollback: 5000, theme: THEME,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.loadAddon(new WebLinksAddon());
      term.open(containerRef.current);
      termRef.current = term;
      fitRef.current = fit;
      term.onData((d) => { if (sessionRef.current) desktop.ssh.write(sessionRef.current, d); });
      const ro = new ResizeObserver(() => {
        try { fit.fit(); } catch { /* not visible yet */ }
        if (sessionRef.current) desktop.ssh.resize(sessionRef.current, term.cols, term.rows);
      });
      ro.observe(containerRef.current);
    }
    const term = termRef.current;
    if (!term) { setPhase("ready"); return; }
    try { fitRef.current?.fit(); } catch { /* ignore */ }
    term.clear();
    term.writeln("\x1b[90m• connecting…\x1b[0m");

    const r = await desktop.ssh.connect(serverId, term.cols, term.rows);
    if (!r.ok) {
      setPhase("ready");
      if (r.code === "HOST_KEY_UNKNOWN" && r.detail?.fingerprint) setPrompt({ kind: "unknown", fingerprint: r.detail.fingerprint });
      else if (r.code === "HOST_KEY_CHANGED") setPrompt({ kind: "changed", expected: r.detail?.expected ?? "", actual: r.detail?.actual ?? "" });
      else {
        term.writeln(`\x1b[31m✗ ${r.message}\x1b[0m`);
        if (r.code === "NO_SECRET" || r.code === "NO_PROFILE" || r.code === "AUTH_FAILED") setEditing(true);
      }
      return;
    }
    sessionRef.current = r.sessionId;
    setPhase("connected");
    term.clear();
    term.focus();
    desktop.ssh.resize(r.sessionId, term.cols, term.rows);
  }, [desktop, serverId]);

  // Output + close events from the main process.
  useEffect(() => {
    const offData = desktop.ssh.onData((id, bytes) => {
      if (id === sessionRef.current) termRef.current?.write(bytes);
    });
    const offClose = desktop.ssh.onClose((id, reason) => {
      if (id !== sessionRef.current) return;
      sessionRef.current = null;
      setPhase("closed");
      termRef.current?.writeln(`\r\n\x1b[33m• session ${reason}\x1b[0m`);
    });
    return () => { offData(); offClose(); };
  }, [desktop]);

  const trust = async (fingerprint: string) => {
    const r = await desktop.ssh.trust(serverId, fingerprint);
    if (!r.ok) return toast.error(r.message);
    void connect();
  };
  const forgetAndRetry = async () => {
    if (!window.confirm("Only do this if you reinstalled or rebuilt this server. If you didn't, someone may be intercepting your connection. Forget the old identity?")) return;
    await desktop.profiles.forgetHostKey(serverId);
    setPrompt(null);
    void connect();
  };
  const disconnect = async () => {
    const sid = sessionRef.current;
    sessionRef.current = null;
    if (sid) await desktop.ssh.close(sid);
    setPhase("closed");
    termRef.current?.writeln("\r\n\x1b[33m• disconnected\x1b[0m");
  };

  const showTerminal = phase === "connecting" || phase === "connected" || phase === "closed";

  return (
    <div className="space-y-4">
      {editing && (
        <ConnectionForm
          desktop={desktop}
          serverId={serverId}
          defaultHost={defaultHost}
          profile={profile}
          onSaved={async () => { await loadProfile(); setEditing(false); }}
          onCancel={profile?.hasSecret ? () => setEditing(false) : undefined}
        />
      )}

      {prompt?.kind === "unknown" && (
        <Card className="border-warning/50 p-5">
          <div className="flex items-start gap-3">
            <ShieldCheck className="mt-0.5 h-5 w-5 text-warning" />
            <div className="min-w-0 flex-1">
              <h3 className="font-semibold">First connection to {serverName}</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Check that this fingerprint matches your server (run <code className="font-mono">ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code> on it).
                Fleet remembers it and will stop you if it ever changes.
              </p>
              <code className="mt-3 block break-all rounded bg-muted px-3 py-2 font-mono text-xs">{prompt.fingerprint}</code>
              <div className="mt-3 flex gap-2">
                <Button onClick={() => trust(prompt.fingerprint)}>Trust and connect</Button>
                <Button variant="ghost" onClick={() => setPrompt(null)}>Cancel</Button>
              </div>
            </div>
          </div>
        </Card>
      )}

      {prompt?.kind === "changed" && (
        <Card className="border-destructive/60 p-5">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 text-destructive" />
            <div className="min-w-0 flex-1">
              <h3 className="font-semibold text-destructive">This server's identity changed</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                The server presented a different host key than the one you trusted before. Fleet did <b>not</b> send your login.
                This can mean someone is intercepting the connection, or that the server was reinstalled.
              </p>
              <dl className="mt-3 space-y-1 font-mono text-xs">
                <div><dt className="inline text-muted-foreground">expected: </dt><dd className="inline break-all">{prompt.expected}</dd></div>
                <div><dt className="inline text-muted-foreground">received: </dt><dd className="inline break-all">{prompt.actual}</dd></div>
              </dl>
              <div className="mt-3 flex gap-2">
                <Button variant="ghost" onClick={() => setPrompt(null)}>Stay disconnected</Button>
                <Button variant="outline" onClick={forgetAndRetry}>I reinstalled it — forget the old identity</Button>
              </div>
            </div>
          </div>
        </Card>
      )}

      <Card className="overflow-hidden border-border/60 bg-[#0b0d12]">
        <div className="flex items-center justify-between border-b border-border/40 bg-card/50 px-3 py-2 font-mono text-[10px] uppercase tracking-widest">
          <div className="flex items-center gap-2 text-muted-foreground">
            <TermIcon className="h-3.5 w-3.5" />
            <span>{serverName} · direct ssh</span>
            {phase === "connected" && <span className="text-success">● connected</span>}
            {phase === "connecting" && <span className="inline-flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> connecting</span>}
            {phase === "closed" && <span>○ closed</span>}
            {profile && <span className="normal-case tracking-normal">· {profile.username}@{profile.host}:{profile.port}</span>}
          </div>
          <div className="flex items-center gap-1">
            {(phase === "ready" || phase === "closed") && profile?.hasSecret && (
              <Button size="sm" variant="ghost" className="h-6 text-[10px]" onClick={connect}>
                {phase === "closed" ? "Reconnect" : "Connect"}
              </Button>
            )}
            {phase === "connected" && (
              <Button size="sm" variant="ghost" className="h-6 text-[10px]" onClick={disconnect}>
                <X className="h-3 w-3" /> Disconnect
              </Button>
            )}
            <Button size="sm" variant="ghost" className="h-6 text-[10px]" onClick={() => setEditing((v) => !v)} aria-label="Connection settings">
              <Settings2 className="h-3 w-3" /> Settings
            </Button>
          </div>
        </div>
        <div className="relative">
          <div ref={containerRef} className={`h-[480px] p-2 ${showTerminal ? "" : "invisible"}`} />
          {!showTerminal && phase !== "loading" && (
            <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-muted-foreground">
              {profile?.hasSecret
                ? "Ready. Click Connect to open a shell straight from this computer."
                : "Set up the connection above to get started."}
            </div>
          )}
        </div>
      </Card>

      <p className="text-xs text-muted-foreground">
        This connects directly from your computer to the server. Your password or key stays in this computer's secure
        storage and is never sent to Fleet. Direct sessions are not recorded in Fleet's audit log.
      </p>
    </div>
  );
}

function ConnectionForm({
  desktop, serverId, defaultHost, profile, onSaved, onCancel,
}: {
  desktop: FleetDesktop;
  serverId: string;
  defaultHost: string;
  profile: DesktopProfile | null;
  onSaved: () => void | Promise<void>;
  onCancel?: () => void;
}) {
  const [host, setHost] = useState(profile?.host ?? defaultHost);
  const [port, setPort] = useState(String(profile?.port ?? 22));
  const [username, setUsername] = useState(profile?.username ?? "root");
  const [authType, setAuthType] = useState<"password" | "key">(profile?.authType ?? "key");
  const [password, setPassword] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await desktop.profiles.save({
        serverId, host: host.trim(), port: Number(port) || 22, username: username.trim(), authType,
        ...(password ? { password } : {}),
        ...(passphrase ? { passphrase } : {}),
      });
      if (!r.ok) return toast.error(r.message);
      setPassword("");
      setPassphrase("");
      if (authType === "key" && !r.profile?.hasSecret) {
        const k = await desktop.profiles.importKey(serverId);
        if (!k.ok) return toast.error(k.message);
        if (!k.imported) return toast.message("Connection saved. Choose your private key to finish.");
      }
      toast.success("Connection saved on this computer.");
      await onSaved();
    } finally {
      setBusy(false);
    }
  };

  const chooseKey = async () => {
    setBusy(true);
    const k = await desktop.profiles.importKey(serverId);
    setBusy(false);
    if (!k.ok) return toast.error(k.message);
    if (k.imported) {
      toast.success(k.encrypted ? "Key saved. It's passphrase-protected; enter the passphrase and save." : "Key saved on this computer.");
      await onSaved();
    }
  };

  return (
    <Card className="p-5">
      <h3 className="font-semibold">SSH connection</h3>
      <p className="mt-1 text-sm text-muted-foreground">Saved on this computer only, in its secure storage.</p>
      <form onSubmit={save} className="mt-4 grid gap-4 sm:grid-cols-6">
        <div className="space-y-1.5 sm:col-span-3">
          <Label htmlFor="ssh-host">Host</Label>
          <Input id="ssh-host" value={host} onChange={(e) => setHost(e.target.value)} required maxLength={253} placeholder="203.0.113.10 or server.example.com" />
        </div>
        <div className="space-y-1.5 sm:col-span-1">
          <Label htmlFor="ssh-port">Port</Label>
          <Input id="ssh-port" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} required />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="ssh-user">Username</Label>
          <Input id="ssh-user" value={username} onChange={(e) => setUsername(e.target.value)} required maxLength={64} autoComplete="off" />
        </div>

        <div className="space-y-1.5 sm:col-span-6">
          <Label>Sign in with</Label>
          <div className="flex gap-2">
            {(["key", "password"] as const).map((t) => (
              <button
                type="button" key={t} onClick={() => setAuthType(t)}
                className={`flex-1 rounded-md border px-3 py-2 text-sm transition-colors ${authType === t ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-muted"}`}
              >
                {t === "key" ? "SSH key" : "Password"}
              </button>
            ))}
          </div>
        </div>

        {authType === "password" ? (
          <div className="space-y-1.5 sm:col-span-6">
            <Label htmlFor="ssh-pass">Password {profile?.hasSecret && profile.authType === "password" && <span className="text-muted-foreground">(saved — leave blank to keep)</span>}</Label>
            <Input id="ssh-pass" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" maxLength={1024} />
          </div>
        ) : (
          <>
            <div className="space-y-1.5 sm:col-span-3">
              <Label>Private key</Label>
              <Button type="button" variant="outline" onClick={chooseKey} disabled={busy} className="w-full justify-start">
                <KeyRound className="h-4 w-4" />
                {profile?.hasSecret && profile.authType === "key" ? "Key saved — choose a different file…" : "Choose private key file…"}
              </Button>
              <p className="text-[11px] text-muted-foreground">Read by the app, not the web page. Usually ~/.ssh/id_ed25519.</p>
            </div>
            <div className="space-y-1.5 sm:col-span-3">
              <Label htmlFor="ssh-pp">Key passphrase <span className="text-muted-foreground">(if it has one)</span></Label>
              <Input id="ssh-pp" type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoComplete="off" maxLength={1024} />
            </div>
          </>
        )}

        <div className="flex gap-2 sm:col-span-6">
          <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
          {onCancel && <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>}
          {profile && (
            <Button type="button" variant="ghost" className="ml-auto text-destructive" disabled={busy}
              onClick={async () => {
                if (!window.confirm("Remove the saved connection (and its password or key) from this computer?")) return;
                await desktop.profiles.remove(serverId);
                await onSaved();
              }}>
              Remove
            </Button>
          )}
        </div>
      </form>
    </Card>
  );
}
