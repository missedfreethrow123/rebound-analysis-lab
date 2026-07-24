import { defineConfig } from "vitest/config";

// Deliberately independent of vite.config.ts, which is wrapped by
// @lovable.dev/vite-tanstack-config (TanStack Start/Nitro plugins that have
// nothing to do with running unit tests). The physics core has no DOM
// dependency, so the default "node" environment is enough.
export default defineConfig({
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
