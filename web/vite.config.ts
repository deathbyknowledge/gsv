import { defineConfig } from "vite";

// In dev, the SPA derives the gateway URL from its own origin (e.g. ws://localhost:5173/ws),
// so the dev server must forward gateway traffic to the running gateway worker. Without this,
// login fails with "WebSocket connect timed out". Override the target with GSV_GATEWAY_URL.
const gatewayTarget = process.env.GSV_GATEWAY_URL || "http://localhost:8787";

// Paths owned by the gateway worker (everything else is served by Vite).
const gatewayPaths = ["/ws", "/oauth", "/health", "/runtime", "/public", "/.well-known"];

const proxy = Object.fromEntries(
  gatewayPaths.map((path) => [
    path,
    { target: gatewayTarget, changeOrigin: true, ws: path === "/ws" },
  ]),
);

export default defineConfig({
  root: ".",
  publicDir: "public",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
  worker: {
    format: "es",
  },
  server: {
    port: 5173,
    open: true,
    proxy,
  },
});
