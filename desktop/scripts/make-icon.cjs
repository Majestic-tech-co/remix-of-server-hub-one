// Renders the app icon (build/icon.png, 1024x1024) from SVG using Electron itself (no extra tools needed).
//   node_modules/electron/dist/electron scripts/make-icon.cjs
const { app, BrowserWindow } = require("electron");
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#8b6cff"/>
      <stop offset="0.55" stop-color="#5b8cff"/>
      <stop offset="1" stop-color="#22d3ee"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.28" cy="0.2" r="0.8">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.35"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect x="48" y="48" width="928" height="928" rx="224" fill="url(#bg)"/>
  <rect x="48" y="48" width="928" height="928" rx="224" fill="url(#glow)"/>
  <!-- pulse line (the "activity" glyph used in the app) -->
  <polyline points="190,520 360,520 440,760 584,260 664,520 834,520"
            fill="none" stroke="#ffffff" stroke-width="64" stroke-linecap="round" stroke-linejoin="round"/>
  <!-- live status light -->
  <circle cx="800" cy="236" r="64" fill="#34d399" stroke="#ffffff" stroke-width="22"/>
</svg>`;

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 1024, height: 1024, useContentSize: true,
    transparent: true, frame: false, backgroundColor: "#00000000",
    webPreferences: { offscreen: true, sandbox: true },
  });
  const html = `<html><body style="margin:0;background:transparent;overflow:hidden">${SVG}</body></html>`;
  await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 400)); // let the first frame paint
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  mkdirSync(join(__dirname, "..", "build"), { recursive: true });
  writeFileSync(join(__dirname, "..", "build", "icon.png"), img.toPNG());
  const s = img.getSize();
  console.log(`icon.png ${s.width}x${s.height}`);
  app.quit();
});
