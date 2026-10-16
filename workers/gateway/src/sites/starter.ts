import { siteSlugSchema } from "@humansandmachines/gsv/protocol";

export function siteStarterFiles(slug: string) {
  siteSlugSchema.parse(slug);
  const title = slug.split("-").filter(Boolean).map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
  const description = "A place for your next idea.";
  return {
    "package.json": JSON.stringify({
      name: slug, private: true, version: "0.0.0", type: "module",
      scripts: { dev: "vite", build: "tsc --noEmit && vite build", preview: "vite preview" },
      engines: { node: "^20.19.0 || >=22.12.0" },
      dependencies: { react: "19.3.1", "react-dom": "19.3.1" },
      devDependencies: {
        "@types/node": "24.19.2", "@types/react": "19.3.0", "@types/react-dom": "19.3.0",
        "@vitejs/plugin-react": "6.1.2", typescript: "7.0.2", vite: "8.3.4",
      },
    }, null, 2) + "\n",
    "site.json": JSON.stringify({ slug, title, description, routing: "spa", output: "dist" }, null, 2) + "\n",
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        target: "ES2022", lib: ["ES2022", "DOM", "DOM.Iterable"], module: "ESNext",
        moduleResolution: "Bundler", jsx: "react-jsx", strict: true, skipLibCheck: true,
        noEmit: true, types: ["vite/client", "node"],
      },
      include: ["src", "vite.config.ts"],
    }, null, 2) + "\n",
    "vite.config.ts": `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: process.env.GSV_SITE_BASE || "./",
});
`,
    "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="description" content="${description}" />
    <title>${title}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
    "src/main.tsx": `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./App.css";

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
`,
    "src/App.tsx": `import { useState } from "react";

export default function App() {
  const [count, setCount] = useState(0);
  return (
    <main>
      <p className="eyebrow">A fresh start</p>
      <h1>${title}</h1>
      <p className="description">${description}</p>
      <button onClick={() => setCount(count + 1)}>Try it <span aria-live="polite">{count}</span></button>
      <p className="hint">Make something worth sharing.</p>
    </main>
  );
}
`,
    "src/App.css": `:root { font-family: Inter, system-ui, sans-serif; color: #24352f; background: #f6f4ed; font-synthesis: none; }
* { box-sizing: border-box; }
body { margin: 0; min-width: 280px; }
main { width: min(100% - 3rem, 54rem); margin: 0 auto; padding: clamp(4rem, 15vh, 10rem) 0; }
.eyebrow { font-size: .8rem; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; }
h1 { margin: 1.5rem 0; font-size: clamp(2.8rem, 9vw, 6rem); line-height: 1.05; letter-spacing: -.05em; overflow-wrap: anywhere; }
.description { max-width: 32rem; font-size: clamp(1.1rem, 3vw, 1.5rem); line-height: 1.6; }
button { display: inline-flex; gap: 1.5rem; align-items: center; margin-top: 1.5rem; border: 0; border-radius: 999px; padding: .9rem 1.3rem; background: #24352f; color: white; font: inherit; cursor: pointer; }
button:hover { background: #3b544a; }
button:focus-visible { outline: 3px solid #b85a28; outline-offset: 4px; }
button span { min-width: 1.5rem; font-variant-numeric: tabular-nums; }
.hint { margin-top: 2rem; color: #59665e; font-size: .9rem; }
`,
    ".gitignore": "node_modules/\ndist/\n.env*\n!.env.example\n",
  } satisfies Record<string, string>;
}
