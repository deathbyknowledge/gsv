import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  publicDir: "public",
  build: {
    outDir: "dist-account",
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: "account/index.html",
    },
  },
  server: {
    port: 5174,
  },
});
