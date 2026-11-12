import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { configSchema, type GsvConfig } from "@gsv/runtime/config";
import { build as bundle } from "esbuild";
import { compileWorkerd, compileWrangler } from "./compile.ts";

export type Build = {
  config: GsvConfig;
  /** The UI's built assets. */
  ui: string;
  wrangler: string;
  workerd: string;
};

/** Reads a deployment's `gsv.config.ts`. */
export async function loadConfig(path: string): Promise<{ config: GsvConfig; dir: string }> {
  const file = resolve(path);
  const { default: config } = await import(pathToFileURL(file).href);
  return { config: configSchema.parse(config), dir: dirname(file) };
}

/**
 * Bundles the runtime once and compiles the config for both targets next to it, so Cloudflare and workerd
 * run the same file.
 */
export async function build(config: GsvConfig, opts: { configDir: string; outDir: string }): Promise<Build> {
  const outDir = resolve(opts.outDir);
  await mkdir(outDir, { recursive: true });
  await bundle({
    entryPoints: {
      worker: createRequire(import.meta.url).resolve("@gsv/runtime"),
      assets: fileURLToPath(new URL("./workerd/assets.ts", import.meta.url)),
    },
    outdir: outDir,
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2024",
    conditions: ["workerd", "worker", "browser"],
    mainFields: ["module", "main"],
    external: ["cloudflare:*", "node:*"],
    logLevel: "warning",
  });
  const ui = resolve(opts.configDir, config.ui);
  const wrangler = join(outDir, "wrangler.jsonc");
  const workerd = join(outDir, "workerd.capnp");
  await writeFile(wrangler, `${JSON.stringify(compileWrangler(config, { main: "worker.js", ui: relative(outDir, ui) }), null, 2)}\n`);
  await writeFile(workerd, compileWorkerd(config, { worker: "worker.js", assets: "assets.js" }));
  return { config, ui, wrangler, workerd };
}
