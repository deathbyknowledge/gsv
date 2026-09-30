import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  base: "/owner/signup/",
  publicDir: "public",
  plugins: [{
    name: "signup-entry",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        return html.replace("/src/main.ts", "/src/signup/main.tsx")
          .replace(/\s*<link rel="manifest"[^>]*>/, "");
      },
    },
  }],
  build: { outDir: "dist/owner-signup", emptyOutDir: true, sourcemap: true },
  worker: { format: "es" },
});
