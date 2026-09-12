import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { unstable_readConfig, type Unstable_RawConfig } from "wrangler";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const gatewayConfig = resolve(root, "workers/gateway/wrangler.jsonc");

/** Direct Wrangler retains the same singleton executor as the standalone Alchemy composition. */
export function standaloneInferenceWranglerConfig(origin: string): Unstable_RawConfig {
  const parsed = new URL(origin);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin) throw new Error("A canonical Gateway origin is required");
  const config = unstable_readConfig({ config: resolve(root, "workers/inference/wrangler.standalone.jsonc") }, { hideWarnings: true });
  return {
    name: config.name, main: config.main, compatibility_date: config.compatibility_date,
    compatibility_flags: config.compatibility_flags, workers_dev: false, preview_urls: false,
    vars: config.vars, ai: config.ai, migrations: config.migrations, durable_objects: config.durable_objects,
    observability: config.observability,
    services: config.services.map((binding: NonNullable<Unstable_RawConfig["services"]>[number]) => ({
      ...binding, props: { ...binding.props, canonicalOrigin: origin },
    })),
  };
}

export async function runStandaloneWrangler(phase: string, args: string[]): Promise<number> {
  if (phase !== "dev" && phase !== "deploy") throw new Error("Choose dev or deploy");
  if (args.some((arg) => ["--config", "-c", "--env", "-e", "--name", "--outdir"].includes(arg.split("=", 1)[0]))) {
    throw new Error("Direct standalone commands keep fixed resource names; use the deployment package for custom compositions");
  }
  const portArg = args.findIndex((arg) => arg === "--port");
  const port = portArg >= 0 ? args[portArg + 1] : args.find((arg) => arg.startsWith("--port="))?.slice(7) ?? "8787";
  const origin = process.env.GSV_GATEWAY_ORIGIN ?? (phase === "dev" ? `http://localhost:${port}` : "");
  if (!origin) throw new Error("Set GSV_GATEWAY_ORIGIN to the existing standalone Gateway HTTPS origin before deploying");
  if (phase === "deploy" && !origin.startsWith("https://")) throw new Error("Standalone deployment requires an HTTPS Gateway origin");
  const inference = standaloneInferenceWranglerConfig(origin);
  const directory = await mkdtemp(resolve(tmpdir(), "gsv-standalone-wrangler-"));
  try {
    const inferenceConfig = resolve(directory, "inference.json");
    await writeFile(inferenceConfig, JSON.stringify(inference), { mode: 0o600 });
    const commands = phase === "dev"
      ? [["dev", "--config", gatewayConfig, "--config", inferenceConfig, ...args]]
      : [["deploy", "--config", inferenceConfig, "--minify", ...args], ["deploy", "--config", gatewayConfig, "--minify", ...args]];
    for (const command of commands) {
      const child = spawnSync(process.execPath, [resolve(root, "node_modules/wrangler/bin/wrangler.js"), ...command], {
        cwd: resolve(root, "workers/gateway"), stdio: "inherit", env: process.env,
      });
      if (child.error) throw child.error;
      if (child.status !== 0) return child.status ?? 1;
    }
    return 0;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runStandaloneWrangler(process.argv[2], process.argv.slice(3)).then((code) => { process.exitCode = code; }).catch((error: Error) => {
    console.error(error.message); process.exitCode = 1;
  });
}
