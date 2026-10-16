import { defineConfig } from "vitest/config";

// Kept separate from vite.config.ts: vitest bundles its own vite types, which clash with the
// plugin types when both live in one defineConfig. Tests here are pure logic, so no plugins are needed.
export default defineConfig({
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
