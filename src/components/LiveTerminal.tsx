import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Terminal as TermIcon, X, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

// Encode/decode helpers (base64 for binary safety on the wire)
const enc = new TextEncoder();
const dec = new TextDecoder();
function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function b64decode(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

interface Props {
  serverId: string;
  serverName: string;
  online: boolean;
}

export function LiveTerminal({ serverId, serverName, online }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const pendingInputRef = useRef<Uint8Array[]>([]);
  const outputAckRef = useRef(0);
  const stoppedRef = useRef(false);
  // Typing wakes the poll loop immediately (instead of waiting out its sleep) and keeps it fast for a moment.
  const wakeRef = useRef<(() => void) | null>(null);
  const fastUntilRef = useRef(0);
  const typedAtRef = useRef(0); // when the oldest not-yet-echoed keystroke was typed
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const [status, setStatus] = useState<"connecting" | "connected" | "closed" | "error">("connecting");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Mount xterm
  useEffect(() => {
    if (!containerRef.current) return;
    const term = new XTerm({
      fontFamily: '"JetBrains Mono", "SF Mono", Menlo, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: true,
      convertEol: false,
      scrollback: 5000,
      theme: {
        background: "#0b0d12",
        foreground: "#e6e6e6",
        cursor: "#7dd3a0",
        black: "#1a1d24",
        red: "#ef6b6b",
        green: "#7dd3a0",
        yellow: "#e6c07b",
        blue: "#79b8ff",
        magenta: "#c792ea",
        cyan: "#5ccfe6",
        white: "#d4d4d4",
        brightBlack: "#5c6370",
        brightRed: "#ff8a8a",
        brightGreen: "#a8e6c1",
        brightYellow: "#fadea0",
        brightBlue: "#9bcaff",
        brightMagenta: "#dab7f5",
        brightCyan: "#8be9fd",
        brightWhite: "#ffffff",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    try { fit.fit(); } catch {}
    termRef.current = term;
    fitRef.current = fit;

    // Outbound input → queue
    term.onData((data) => {
      pendingInputRef.current.push(enc.encode(data));
      if (!typedAtRef.current) typedAtRef.current = performance.now();
      fastUntilRef.current = Date.now() + 1500;
      wakeRef.current?.();
    });

    // Resize handler
    const ro = new ResizeObserver(() => {
      try { fit.fit(); } catch {}
    });
    ro.observe(containerRef.current);

    return () => {
      stoppedRef.current = true;
      ro.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      // Best-effort close
      const sid = sessionIdRef.current;
      if (sid) {
        void closeSession(sid).catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Connect
  useEffect(() => {
    if (!termRef.current || !fitRef.current) return;
    let cancelled = false;
    stoppedRef.current = false;

    (async () => {
      const term = termRef.current!;
      try { fitRef.current!.fit(); } catch {}
      const cols = term.cols;
      const rows = term.rows;
      lastSizeRef.current = { cols, rows };

      term.writeln("\x1b[90m• connecting…\x1b[0m");
      const headers = await authHeaders();
      const res = await fetch("/api/terminal/start", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ server_id: serverId, cols, rows }),
      });
      if (!res.ok) {
        const t = await res.text();
        setStatus("error");
        setErrorMsg(t);
        term.writeln(`\x1b[31m✗ ${t}\x1b[0m`);
        return;
      }
      const { session_id } = (await res.json()) as { session_id: string };
      if (cancelled) return;
      sessionIdRef.current = session_id;
      setStatus("connected");
      term.writeln(`\x1b[90m• session ${session_id.slice(0, 8)} ready — waiting for shell…\x1b[0m`);

      // Poll loop
      pollLoop();
    })().catch((e) => {
      setStatus("error");
      setErrorMsg(String(e));
    });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  async function pollLoop() {
    const term = termRef.current;
    if (!term) return;
    while (!stoppedRef.current && sessionIdRef.current) {
      const sid = sessionIdRef.current;
      // Drain pending input into one base64 chunk
      let inputB64 = "";
      if (pendingInputRef.current.length > 0) {
        const total = pendingInputRef.current.reduce((n, b) => n + b.length, 0);
        const merged = new Uint8Array(total);
        let off = 0;
        for (const b of pendingInputRef.current) { merged.set(b, off); off += b.length; }
        pendingInputRef.current = [];
        inputB64 = b64encode(merged);
      }

      // Detect resize
      let cols: number | undefined;
      let rows: number | undefined;
      if (term.cols !== lastSizeRef.current?.cols || term.rows !== lastSizeRef.current?.rows) {
        cols = term.cols;
        rows = term.rows;
        lastSizeRef.current = { cols, rows };
      }

      const headers = await authHeaders();
      let payload: { status: string; output_b64: string; output_seq: number };
      try {
        const res = await fetch("/api/terminal/poll", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify({
            session_id: sid,
            output_ack: outputAckRef.current,
            input_b64: inputB64 || undefined,
            cols,
            rows,
          }),
        });
        if (!res.ok) throw new Error(await res.text());
        payload = await res.json();
      } catch (e) {
        // Brief backoff on error then retry
        await sleep(1000);
        continue;
      }

      if (payload.output_b64) {
        // One base64 chunk per line. (Decoding several padded chunks in one atob() call throws.)
        for (const part of payload.output_b64.split("\n")) {
          if (!part) continue;
          try { term.write(dec.decode(b64decode(part), { stream: true })); } catch { /* skip a corrupt chunk */ }
        }
        outputAckRef.current += payload.output_b64.length;
        if (typedAtRef.current) {
          // time from keystroke to its echo appearing: the number that matters for "does typing feel laggy"
          const ms = Math.round(performance.now() - typedAtRef.current);
          typedAtRef.current = 0;
          setLatencyMs((prev) => (prev === null ? ms : Math.round(prev * 0.6 + ms * 0.4)));
        }
      }

      if (payload.status === "closed") {
        setStatus("closed");
        term.writeln("\r\n\x1b[33m• session closed\x1b[0m");
        sessionIdRef.current = null;
        return;
      }

      // Adaptive interval: near-continuous while you're typing or output is flowing, relaxed when idle.
      // A keystroke interrupts the idle sleep right away.
      if (payload.output_b64 || inputB64) fastUntilRef.current = Date.now() + 1500;
      const fast = Date.now() < fastUntilRef.current;
      await new Promise<void>((resolve) => {
        const t = setTimeout(done, fast ? 10 : 250);
        function done() { clearTimeout(t); wakeRef.current = null; resolve(); }
        wakeRef.current = done;
      });
    }
  }

  async function closeSession(sid: string) {
    try {
      const headers = await authHeaders();
      await fetch("/api/terminal/poll", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ session_id: sid, output_ack: outputAckRef.current, close: true }),
        keepalive: true,
      });
    } catch {}
  }

  async function reconnect() {
    const sid = sessionIdRef.current;
    if (sid) await closeSession(sid).catch(() => {});
    sessionIdRef.current = null;
    outputAckRef.current = 0;
    stoppedRef.current = true;
    if (termRef.current) termRef.current.clear();
    // Trigger the connect effect by toggling: easiest is to bump a key on parent
    // Here we just restart inline:
    stoppedRef.current = false;
    const term = termRef.current!;
    try { fitRef.current!.fit(); } catch {}
    term.writeln("\x1b[90m• reconnecting…\x1b[0m");
    const headers = await authHeaders();
    const res = await fetch("/api/terminal/start", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ server_id: serverId, cols: term.cols, rows: term.rows }),
    });
    if (!res.ok) { setStatus("error"); return; }
    const { session_id } = (await res.json()) as { session_id: string };
    sessionIdRef.current = session_id;
    setStatus("connected");
    pollLoop();
  }

  return (
    <Card className="overflow-hidden border-border/60 bg-[#0b0d12]">
      <div className="flex items-center justify-between border-b border-border/40 bg-card/50 px-3 py-2 font-mono text-[10px] uppercase tracking-widest">
        <div className="flex items-center gap-2 text-muted-foreground">
          <TermIcon className="h-3.5 w-3.5" />
          <span>{serverName} · live shell</span>
          <StatusBadge status={status} online={online} />
          {status === "connected" && latencyMs !== null && (
            <span className={latencyMs > 500 ? "text-warning" : "text-muted-foreground"} title="Time from a keystroke to its echo appearing">
              · echo {latencyMs} ms
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {(status === "closed" || status === "error") && (
            <Button size="sm" variant="ghost" onClick={reconnect} className="h-6 text-[10px]">
              Reconnect
            </Button>
          )}
          {status === "connected" && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                const sid = sessionIdRef.current;
                if (sid) void closeSession(sid);
                stoppedRef.current = true;
                setStatus("closed");
                termRef.current?.writeln("\r\n\x1b[33m• disconnected\x1b[0m");
                sessionIdRef.current = null;
              }}
              className="h-6 text-[10px]"
            >
              <X className="h-3 w-3" /> Disconnect
            </Button>
          )}
        </div>
      </div>
      {!online && (
        <div className="border-b border-border/40 bg-warning/10 px-3 py-1.5 text-xs text-warning">
          ⚠ Server is offline — shell will connect once the agent reconnects.
        </div>
      )}
      {errorMsg && (
        <div className="border-b border-border/40 bg-destructive/10 px-3 py-1.5 font-mono text-xs text-destructive">
          {errorMsg}
        </div>
      )}
      <div ref={containerRef} className="h-[65vh] min-h-[480px] w-full p-2" />
    </Card>
  );
}

function StatusBadge({ status, online }: { status: string; online: boolean }) {
  if (status === "connecting") {
    return (
      <span className="inline-flex items-center gap-1 text-warning">
        <Loader2 className="h-3 w-3 animate-spin" /> connecting
      </span>
    );
  }
  if (status === "connected") {
    return <span className="inline-flex items-center gap-1 text-primary">● live</span>;
  }
  if (status === "closed") return <span className="text-muted-foreground">○ closed</span>;
  if (status === "error") return <span className="text-destructive">✗ error</span>;
  return <span className={online ? "text-success" : "text-destructive"}>{online ? "online" : "offline"}</span>;
}

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
