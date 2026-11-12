import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { build, loadConfig, type Build } from "./build.ts";
import { issueSetup, newSecret } from "./setup.ts";
import { startWorkerd } from "./workerd/run.ts";

const USAGE = `Usage: gsv <command> [options]

Commands:
  build    Bundle the runtime and compile the config for Cloudflare and workerd
  dev      Run the deployment on local workerd
  deploy   Deploy to Cloudflare with wrangler

Options:
  --config <path>  The deployment's gsv.config.ts (default: config/gsv.config.ts)
  --port <n>       dev: the port to listen on (default: 8787)
  --setup          dev, deploy: print a new one-time setup link for the first space
  --dry-run        deploy: compile and check without uploading
`;

/** Builds, local data and dev secrets, like `.wrangler`. */
const STATE = resolve(".gsv");
const WRANGLER = join(dirname(createRequire(import.meta.url).resolve("wrangler/package.json")), "bin", "wrangler.js");

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: "string", default: "config/gsv.config.ts" },
    port: { type: "string", default: "8787" },
    setup: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

async function buildCommand(): Promise<void> {
  const { config, dir } = await loadConfig(values.config);
  const output = await build(config, { configDir: dir, outDir: join(STATE, "build", config.name) });
  console.log(`Built ${config.name}:\n  ${output.wrangler}\n  ${output.workerd}`);
}

/** The deployment on local workerd. Its secret and data persist under `.gsv/dev/<name>`; the first start prints the setup link. */
async function dev(): Promise<void> {
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`Not a port: ${values.port}`);
  const { config, dir } = await loadConfig(values.config);
  const root = join(STATE, "dev", config.name);
  const output = await build(config, { configDir: dir, outDir: join(root, "build") });
  requireUi(output);
  const data = join(root, "data");
  await mkdir(data, { recursive: true });
  const secretsPath = join(root, "secrets.json");
  const saved = existsSync(secretsPath) ? JSON.parse(await readFile(secretsPath, "utf8")) as { GSV_SECRET: string; GSV_SETUP: string } : undefined;
  const issued = !saved || values.setup ? issueSetup() : undefined;
  const secrets = { GSV_SECRET: saved?.GSV_SECRET ?? newSecret(), GSV_SETUP: issued ? issued.binding : saved?.GSV_SETUP ?? "" };

  const workerd = await startWorkerd(output, { data, port, env: secrets, inherit: true });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void workerd.stop());
  // Saved once workerd runs, so a failed start leaves no unseen setup link behind.
  if (issued) await writeFile(secretsPath, JSON.stringify(secrets), { mode: 0o600 });
  console.log(`gsv dev is serving ${config.name} at http://${config.domain}:${port}`);
  if (issued) console.log(`Set up the first space: http://${config.operatorSpace}.${config.domain}:${port}/setup#${issued.code}`);
  process.exitCode = (await workerd.exited) ?? 0;
}

/**
 * Deploys with wrangler. A Worker without a setup secret is new: it gets the deployment secret and a
 * setup link. The deployment secret is never replaced, since every session derives from it.
 */
async function deploy(): Promise<void> {
  const { config, dir } = await loadConfig(values.config);
  const outDir = join(STATE, "deploy", config.name);
  const output = await build(config, { configDir: dir, outDir });
  requireUi(output);
  if (values["dry-run"]) {
    await wrangler(["deploy", "--config", output.wrangler, "--dry-run", "--outdir", join(outDir, "dry-run")]);
    return;
  }
  const existing = await secretNames(output.wrangler);
  const issued = values.setup || !existing.includes("GSV_SETUP") ? issueSetup() : undefined;
  const secrets = {
    ...(existing.includes("GSV_SECRET") ? {} : { GSV_SECRET: newSecret() }),
    ...(issued ? { GSV_SETUP: issued.binding } : {}),
  };
  const temp = await mkdtemp(join(tmpdir(), "gsv-deploy-"));
  try {
    const file = join(temp, "secrets.json");
    await writeFile(file, JSON.stringify(secrets), { mode: 0o600 });
    await wrangler(["deploy", "--config", output.wrangler, ...(Object.keys(secrets).length ? ["--secrets-file", file] : [])]);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
  if (issued) console.log(`Set up the first space: https://${config.operatorSpace}.${config.domain}/setup#${issued.code}`);
}

async function secretNames(config: string): Promise<string[]> {
  const { code, stdout, output } = await wrangler(["secret", "list", "--config", config, "--format", "json"], { capture: true });
  if (code === 0) return (JSON.parse(stdout.slice(stdout.indexOf("["))) as { name: string }[]).map(secret => secret.name);
  // A Worker that was never deployed has no secrets yet.
  if (output.includes("[code: 10007]")) return [];
  throw new Error(`wrangler couldn't list the Worker's secrets:\n${output}`);
}

function wrangler(args: string[], opts: { capture?: boolean } = {}): Promise<{ code: number; stdout: string; output: string }> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [WRANGLER, ...args], { stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit" });
    let stdout = "";
    let output = "";
    child.stdout?.on("data", chunk => { stdout += String(chunk); output += String(chunk); });
    child.stderr?.on("data", chunk => { output += String(chunk); });
    child.once("error", fail);
    child.once("exit", code => {
      if (code !== 0 && !opts.capture) fail(new Error(`wrangler ${args[0]} failed`));
      else done({ code: code ?? 1, stdout, output });
    });
  });
}

function requireUi(output: Build): void {
  if (!existsSync(join(output.ui, "index.html"))) throw new Error(`No built UI at ${output.ui}. Build the UI the config names first.`);
}

const command = new Map([["build", buildCommand], ["dev", dev], ["deploy", deploy]]).get(positionals[0] ?? "");
if (values.help || !command) {
  console.log(USAGE);
  if (!values.help) process.exitCode = 1;
} else {
  await command().catch((error: unknown) => {
    console.error(error instanceof z.ZodError ? z.prettifyError(error) : error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
