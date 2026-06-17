import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = path.join(packageRoot, "src");
const distRoot = path.join(packageRoot, "dist");

async function collectTypeScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return collectTypeScriptFiles(entryPath);
      }
      return entry.isFile() && entry.name.endsWith(".ts") ? [entryPath] : [];
    }),
  );
  return files.flat();
}

const entryPoints = await collectTypeScriptFiles(srcRoot);

await build({
  bundle: true,
  entryPoints,
  format: "esm",
  logLevel: "info",
  outbase: srcRoot,
  outdir: distRoot,
  packages: "external",
  platform: "neutral",
  target: "es2024",
});
