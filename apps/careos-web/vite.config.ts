import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The server stays unchanged and has CORS off by default, so the browser talks to it through this
// dev proxy (same origin). SSE endpoints (/api/trace, /api/turns/:id/stream) pass straight through.
const target = process.env.CAREOS_SERVER ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target, changeOrigin: true },
      "/mcp": { target, changeOrigin: true },
      "/healthz": { target, changeOrigin: true },
    },
  },
});
