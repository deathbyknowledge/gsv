import { resolve } from "node:path";
import { defineConfig } from "vite";

const previewStyles = process.env.GSV_DESKTOP_PREVIEW_CSS;
const desktopEntry = resolve(import.meta.dirname, "src/desktop/main.tsx");

export default defineConfig({
  root: ".",
  publicDir: "public",
  plugins: [{
    name: "desktop-entry",
    transform(source, id) {
      if (previewStyles && id === desktopEntry) {
        return { code: `${source}\nimport ${JSON.stringify(resolve(previewStyles))};\n`, map: null };
      }
    },
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        return html.replace("/src/main.ts", "/src/desktop/main.tsx");
      },
    },
  }],
  build: { outDir: "dist-tauri", emptyOutDir: true, sourcemap: true },
  worker: { format: "es" },
  server: { host: "localhost", port: 5186, strictPort: true, open: false },
});
