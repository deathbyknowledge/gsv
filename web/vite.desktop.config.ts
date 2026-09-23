import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  publicDir: "public",
  plugins: [{
    name: "desktop-entry",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        return html.replace("/src/main.ts", "/src/desktop/main.tsx");
      },
    },
  }],
  build: { outDir: "dist-desktop", emptyOutDir: true, sourcemap: true },
  worker: { format: "es" },
  server: { host: "localhost", port: 5186, strictPort: true, open: false },
});
