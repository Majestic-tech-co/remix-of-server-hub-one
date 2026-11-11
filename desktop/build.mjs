// Bundles the Electron main process and preload script. Dependencies (ssh2, zod) stay external and are
// loaded from node_modules at runtime; the packager must include them.
import { build } from "esbuild";

const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: false,
  packages: "external",
  external: ["electron"],
  logLevel: "info",
};

await build({ ...common, entryPoints: ["src/main.ts"], outfile: "dist/main.cjs" });
await build({ ...common, entryPoints: ["src/preload.ts"], outfile: "dist/preload.cjs" });
