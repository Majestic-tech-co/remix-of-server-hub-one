// Electron main process: opens the Fleet web app in a locked-down window and provides the SSH bridge.
import { join } from "node:path";
import { readFileSync, statSync } from "node:fs";
import { app, BrowserWindow, dialog, ipcMain, safeStorage, session, shell, webContents, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { createApi, type Ctx } from "./api";
import { isAllowedOrigin } from "./security";
import { SshManager } from "./ssh";
import { ProfileStore, type SecretBox } from "./store";

const DEFAULT_APP_URL = "https://server-hub-one.vercel.app";
// Development builds may point at a local dev server; packaged builds always use the real site.
const APP_URL = !app.isPackaged && process.env.FLEET_APP_URL ? process.env.FLEET_APP_URL : DEFAULT_APP_URL;
const DEV = !app.isPackaged;
const ALLOWED = new URL(APP_URL).origin;

/** OS-keychain-backed encryption. If the OS can't provide real encryption we refuse to store secrets. */
const keychain: SecretBox = {
  available: () => {
    if (!safeStorage.isEncryptionAvailable()) return false;
    // On Linux without a keyring Electron falls back to a hard-coded password ("basic_text"): not real protection.
    const backend = (safeStorage as unknown as { getSelectedStorageBackend?: () => string }).getSelectedStorageBackend?.();
    return backend !== "basic_text";
  },
  encrypt: (plain) => safeStorage.encryptString(plain),
  decrypt: (data) => safeStorage.decryptString(data),
};

const store = new ProfileStore(join(app.getPath("userData"), "ssh-profiles.json"), keychain);

const ssh = new SshManager(store, {
  onData: (id, data, owner) => webContents.fromId(owner)?.send("ssh:data", id, new Uint8Array(data)),
  onClose: (id, reason, owner) => webContents.fromId(owner)?.send("ssh:close", id, reason),
});

const api = createApi({
  store,
  ssh,
  allowedOrigin: ALLOWED,
  dev: DEV,
  pickKeyFile: async () => {
    const win = BrowserWindow.getFocusedWindow() ?? undefined;
    const r = await dialog.showOpenDialog(win!, {
      title: "Choose your SSH private key",
      properties: ["openFile", "showHiddenFiles"],
      defaultPath: app.getPath("home"),
    });
    const path = r.filePaths[0];
    if (r.canceled || !path) return null;
    if (statSync(path).size > 100_000) throw new Error("file too large");
    return { name: path, text: readFileSync(path, "utf8") };
  },
});

function ctxOf(e: IpcMainInvokeEvent | IpcMainEvent): Ctx {
  return { owner: e.sender.id, url: e.senderFrame?.url, isMainFrame: e.senderFrame === e.sender.mainFrame };
}

function registerIpc() {
  const handle = <K extends keyof typeof api>(channel: string, method: K) =>
    ipcMain.handle(channel, (e, input: unknown) => (api[method] as (c: Ctx, i: unknown) => unknown)(ctxOf(e), input));
  handle("profiles:get", "profileGet");
  handle("profiles:save", "profileSave");
  handle("profiles:importKey", "profileImportKey");
  handle("profiles:remove", "profileRemove");
  handle("profiles:forgetHostKey", "forgetHostKey");
  handle("ssh:connect", "sshConnect");
  handle("ssh:trust", "sshTrust");
  handle("ssh:close", "sshClose");
  // keystrokes and resizes: fire-and-forget for low latency
  ipcMain.on("ssh:write", (e, input: unknown) => { void api.sshWrite(ctxOf(e), input); });
  ipcMain.on("ssh:resize", (e, input: unknown) => { void api.sshResize(ctxOf(e), input); });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0b0d12",
    title: "Fleet",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,   // the page can't reach the preload's internals
      nodeIntegration: false,   // the page has no Node.js
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      devTools: DEV,
      // lets the preload tell the page which app version this is (the website offers updates)
      additionalArguments: [`--fleet-app-version=${app.getVersion()}`],
    },
  });

  const wc = win.webContents;
  const id = wc.id;

  // Never leave the Fleet origin inside this window. Other links open in the user's normal browser.
  const openExternally = (url: string) => {
    try {
      const u = new URL(url);
      if (u.protocol === "https:" || u.protocol === "http:" || u.protocol === "mailto:") void shell.openExternal(url);
    } catch { /* ignore malformed URLs */ }
  };
  wc.setWindowOpenHandler(({ url }) => {
    if (!isAllowedOrigin(url, ALLOWED, { dev: DEV })) openExternally(url);
    return { action: "deny" };
  });
  const guard = (event: { preventDefault(): void }, url: string) => {
    if (!isAllowedOrigin(url, ALLOWED, { dev: DEV })) {
      event.preventDefault();
      openExternally(url);
    }
  };
  wc.on("will-navigate", (e, url) => guard(e, url));
  wc.on("will-redirect", (e, url) => guard(e, url));

  // Any real navigation or reload ends this window's SSH sessions: a fresh page starts clean.
  wc.on("did-start-navigation", (_e, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) ssh.closeAllFor(id);
  });
  win.on("closed", () => ssh.closeAllFor(id));

  void win.loadURL(APP_URL);
  return win;
}

app.on("web-contents-created", (_e, contents) => {
  contents.on("will-attach-webview", (e) => e.preventDefault()); // no <webview> tags
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w) { if (w.isMinimized()) w.restore(); w.focus(); }
  });

  void app.whenReady().then(() => {
    // The site doesn't need camera, microphone, location, etc. Deny every permission request.
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    registerIpc();
    createWindow();
    app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });

  app.on("window-all-closed", () => {
    ssh.closeAll();
    if (process.platform !== "darwin") app.quit();
  });
  app.on("before-quit", () => ssh.closeAll());
}
