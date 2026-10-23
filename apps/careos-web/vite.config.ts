import { resolve } from "node:path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The server has CORS off by default, so the browser talks to it through this dev proxy (same origin).
// SSE endpoints (/api/trace, /api/turns/:id/stream) pass straight through.
//
// When the server runs with CAREOS_TOKENS (bearer auth), set CAREOS_WEB_TOKEN to one of those tokens: the proxy
// adds it as `Authorization: Bearer ...` on the server side of the hop. It never reaches the browser bundle, and
// EventSource (which cannot set headers) works unchanged.
export default defineConfig(({ mode }) => {
// The repo-root .env is shared with the server; Vite only reads apps/careos-web/.env by default.
const env = { ...loadEnv(mode, resolve(import.meta.dirname, "../.."), ""), ...process.env };
const target = env.CAREOS_SERVER ?? "http://127.0.0.1:8787";
const token = env.CAREOS_WEB_TOKEN;
const headers = token ? { authorization: `Bearer ${token}` } : undefined;

return {
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target, changeOrigin: true, headers },
      "/mcp": { target, changeOrigin: true, headers },
      "/healthz": { target, changeOrigin: true },
    },
  },
};
});
