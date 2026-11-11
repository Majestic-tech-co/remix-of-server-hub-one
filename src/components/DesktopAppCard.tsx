import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Download, Laptop } from "lucide-react";
import { useDesktop } from "@/lib/desktop";
import { compareVersions } from "@/lib/semver";
import { authedPost } from "@/lib/servers";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

type Info = { version: string; name: string; size: number };

const mb = (bytes: number) => `${Math.round(bytes / 1_000_000)} MB`;

/** Download the Windows app (or, inside the app, show the version and offer updates). */
export function DesktopAppCard() {
  const desktop = useDesktop();
  const [info, setInfo] = useState<Info | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    authedPost<Info>("/api/desktop/download", { action: "info" }).then(({ data, error }) => {
      if (!live) return;
      if (data) setInfo(data);
      else setUnavailable(error ?? "Downloads aren't available right now.");
    });
    return () => { live = false; };
  }, []);

  const installed = desktop?.appVersion;
  const update = !!installed && !!info && compareVersions(info.version, installed) > 0;
  const upToDate = !!installed && !!info && !update;
  const isWindows = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);

  const download = async () => {
    setBusy(true);
    const { data, error } = await authedPost<Info & { url: string }>("/api/desktop/download", { action: "link" });
    setBusy(false);
    if (error || !data) return toast.error(error ?? "Couldn't start the download. Please try again.");
    toast.success(`Downloading ${data.name}…`);
    window.location.assign(data.url); // GitHub's short-lived signed link; the browser saves the file
  };

  return (
    <Card className="p-6" id="desktop">
      <div className="flex items-start gap-3">
        <Laptop className="mt-0.5 h-5 w-5 text-primary" />
        <div className="flex-1">
          <h3 className="font-semibold">Fleet desktop app</h3>

          {installed ? (
            <p className="mt-1 text-sm text-muted-foreground">
              You're using the desktop app (version {installed}).{" "}
              {update ? `Version ${info!.version} is available.` : upToDate ? "You're up to date." : ""}
            </p>
          ) : (
            <p className="mt-1 text-sm text-muted-foreground">
              The Fleet website in its own window, plus <b>direct SSH from your computer</b> to your servers: typing goes
              straight to the server with no web hops, so it feels like a normal terminal.
            </p>
          )}

          {unavailable && !info && (
            <p className="mt-3 rounded-md border border-border/60 bg-muted/40 p-3 text-sm text-muted-foreground">{unavailable}</p>
          )}

          {info && (!installed || update) && (
            <>
              <Button className="mt-4" onClick={download} disabled={busy}>
                <Download className="h-4 w-4" />
                {busy ? "Preparing…" : update ? `Download update (v${info.version})` : `Download for Windows (v${info.version} · ${mb(info.size)})`}
              </Button>
              {!isWindows && !installed && (
                <p className="mt-2 text-xs text-muted-foreground">The installer is for Windows. Mac and Linux versions aren't available yet.</p>
              )}
              <ol className="mt-4 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
                {update ? <li>Close the Fleet app, then run the installer you downloaded. Your saved connections are kept.</li> : <li>Run <code className="font-mono text-foreground">{info.name}</code> once it downloads. It installs for your user only; no administrator needed.</li>}
                <li>
                  Windows may say <i>"Windows protected your PC"</i> because the app isn't code-signed yet. Click <b>More info</b>, then <b>Run anyway</b>.
                </li>
                {!installed && <li>Open Fleet from the Start menu, sign in, then open a server and choose the <b>SSH</b> tab.</li>}
              </ol>
            </>
          )}
        </div>
      </div>
    </Card>
  );
}
