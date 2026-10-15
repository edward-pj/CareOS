import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const pkg = (p: string) => fileURLToPath(new URL(`../../packages/open-caregiver-mcp/src/${p}`, import.meta.url));

export default defineConfig({
  // Resolve ONLY the workspace package from source (no build step needed). A global
  // "source" condition would also pull raw .ts out of third-party node_modules.
  resolve: {
    alias: [
      { find: /^open-caregiver-mcp\/http$/, replacement: pkg("http.ts") },
      { find: /^open-caregiver-mcp$/, replacement: pkg("server.ts") },
    ],
  },
  test: { testTimeout: 20_000 },
});
