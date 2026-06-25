import { defineConfig } from "vite";

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
  },
});
