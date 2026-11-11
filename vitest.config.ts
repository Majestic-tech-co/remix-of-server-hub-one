import { defineConfig } from "vitest/config";
import tsConfigPaths from "vite-tsconfig-paths";

// Separate from vite.config.ts so tests don't load the TanStack Start / Nitro build plugins.
export default defineConfig({
  plugins: [tsConfigPaths({ projects: ["./tsconfig.json"] })],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
