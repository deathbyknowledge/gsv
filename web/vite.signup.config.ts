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
          .replace(/\s*<link rel="manifest"[^>]*>/, "")
          .replace("</body>", '<noscript><p>Creating a Ship requires JavaScript. <a href="/owner/login">Sign in to Accounts</a> to manage product emails without JavaScript. Product emails are optional.</p></noscript></body>');
      },
    },
  }],
  build: { outDir: "dist/owner-signup", emptyOutDir: true, sourcemap: true },
  worker: { format: "es" },
});
