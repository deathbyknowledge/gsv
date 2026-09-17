import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { fork } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";
import { parseEnv } from "node:util";
import { unstable_readConfig } from "wrangler";
import { createServer } from "vite";
import { integrationGatewayConfig, integrationDependencyConfig } from "../test-integration/harness";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const keyFile = process.env.GSV_TYPESAFE_ENV_FILE;
const ripgitMain = process.env.GSV_PREVIEW_RIPGIT_MAIN;
const assetsDir = process.env.GSV_PREVIEW_ASSETS_DIR;
if (!keyFile || !ripgitMain || !assetsDir) throw new Error("Set GSV_TYPESAFE_ENV_FILE, GSV_PREVIEW_RIPGIT_MAIN and GSV_PREVIEW_ASSETS_DIR for this isolated preview");
const key = parseEnv(await readFile(keyFile, "utf8")).TYPESAFE_API_KEY?.trim();
if (!key) throw new Error("TYPESAFE_API_KEY is not set in the private environment file");
const temporary = await mkdtemp(resolve(tmpdir(), "gsv-workspace-"));
const stateDirectory = resolve(process.env.GSV_WORKSPACE_STATE_DIR ?? resolve(homedir(), ".local/state/gsv/workspace-preview"));
await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
const port = Number(process.env.GSV_WORKSPACE_PORT || 5184);
// Set the development directory's canonical origin before the human creates the account.
const origin = `http://localhost:${port}`;
const alias = {
  "@humansandmachines/gsv": resolve(repo, "packages/gsv/src"),
  "@humansandmachines/gsv-inference": resolve(repo, "packages/inference/src"),
};
const gateway = integrationGatewayConfig();
gateway.alias = alias;
gateway.assets = { ...gateway.assets, directory: assetsDir };
gateway.services = gateway.services?.map((binding) => binding.binding === "RIPGIT" ? { ...binding, service: "workspace-ripgit" } : binding);
const dependencies = integrationDependencyConfig("gsv");
dependencies.alias = alias;
const dependencyMain = resolve(temporary, "directory.ts");
await writeFile(dependencyMain, `import Dependencies from ${JSON.stringify(resolve(repo, "workers/gateway/test-integration/fixtures/dependencies.ts"))};
export * from ${JSON.stringify(resolve(repo, "workers/gateway/test-integration/fixtures/dependencies.ts"))};
export default class PreviewDirectory extends Dependencies {
  override async resolveHostname(hostname: string) {
    const result = await super.resolveHostname(hostname);
    return result.found && result.handle === "default"
      ? { ...result, canonicalOrigin: ${JSON.stringify(origin)} } : result;
  }
  override async authorizeInstallationOnboarding(input: Parameters<Dependencies["authorizeInstallationOnboarding"]>[0]) {
    const result = await super.authorizeInstallationOnboarding({ ...input, token: input.token === "onboard_integration_default_onboarding_token" ? "integration-onboarding-default" : input.token });
    return result.ok && result.installation.handle === "default"
      ? { ...result, installation: { ...result.installation, canonicalOrigin: ${JSON.stringify(origin)} } } : result;
  }
}`);
dependencies.main = dependencyMain;
const inference = unstable_readConfig({ config: resolve(repo, "workers/inference/wrangler.dev.jsonc") }, { hideWarnings: true });
const inferenceDirectory = resolve(temporary, "inference");
await mkdir(inferenceDirectory, { mode: 0o700 });
const inferenceConfig = resolve(inferenceDirectory, "wrangler.jsonc");
await writeFile(inferenceConfig, JSON.stringify({
  name: "gsv-execution-test", main: resolve(repo, "workers/inference/src/index.ts"),
  compatibility_date: inference.compatibility_date, compatibility_flags: inference.compatibility_flags,
  alias, ai: { binding: "AI", remote: true },
  vars: inference.vars, durable_objects: inference.durable_objects, migrations: inference.migrations,
  services: [{ binding: "INSTALLATION_DIRECTORY", service: "gsv-test-dependencies" }],
}));
await writeFile(resolve(inferenceDirectory, ".dev.vars"), `TYPESAFE_API_KEY=${JSON.stringify(key)}\n`, { mode: 0o600 });
const configs = [
  ["gateway", gateway], ["directory", dependencies],
  ["ripgit", {
    name: "workspace-ripgit", main: ripgitMain, compatibility_date: "2026-07-29",
    durable_objects: { bindings: [{ name: "REPOSITORY", class_name: "Repository" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["Repository"] }],
  }],
] as const;
const configPaths: string[] = [];
for (const [name, config] of configs) {
  const path = resolve(temporary, `${name}.jsonc`);
  await writeFile(path, JSON.stringify(config));
  configPaths.push(path);
}
configPaths.push(inferenceConfig);
const backend = fork(resolve(repo, "node_modules/wrangler/bin/wrangler.js"), [
  "dev", ...configPaths.flatMap((path) => ["--config", path]),
  "--ip", "127.0.0.1", "--port", "0", "--inspector-port", "0",
  "--persist-to", stateDirectory, "--log-level", "error",
], {
  cwd: repo, execArgv: [], stdio: ["ignore", "inherit", "inherit", "ipc"],
  env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
});
const url = await new Promise<URL>((resolveReady, reject) => {
  backend.once("error", reject);
  backend.once("exit", (code) => reject(new Error(`Workspace backend exited before startup (${code})`)));
  backend.on("message", (message: unknown) => {
    const ready: unknown = typeof message === "string" ? JSON.parse(message) : message;
    if (ready && typeof ready === "object" && "event" in ready && ready.event === "DEV_SERVER_READY"
      && "port" in ready && typeof ready.port === "number") {
      resolveReady(new URL(`http://127.0.0.1:${ready.port}`));
    }
  });
});
const proxy = Object.fromEntries(["/ws", "/oauth", "/health", "/runtime", "/public", "/.well-known"].map((path) => [path, {
  target: url.origin, changeOrigin: true, ws: path === "/ws",
}]));
const vite = await createServer({
  configFile: false, root: resolve(repo, "web"),
  resolve: { alias: Object.entries(alias).map(([find, replacement]) => ({ find, replacement })), dedupe: ["preact", "@tanstack/preact-query"] },
  server: { host: "127.0.0.1", port, strictPort: true, open: false, proxy,
    fs: { strict: true, allow: [repo] } },
});
await vite.listen();
await writeFile("/tmp/gsv-workspace-preview-url", origin);
console.log(`Workspace preview: ${origin}`);
console.log(`Persistent local data: ${stateDirectory}. Backend source changes reload automatically.`);
console.log("For a fresh state directory, use /onboarding#onboard_integration_default_onboarding_token.");
let stopping = false;
const stop = async (code = 0) => {
  if (stopping) return;
  stopping = true;
  await vite.close();
  if (backend.exitCode === null && backend.signalCode === null) {
    const exited = new Promise<void>((resolveExit) => backend.once("exit", () => resolveExit()));
    backend.kill("SIGTERM");
    await exited;
  }
  await rm(temporary, { recursive: true, force: true });
  process.exit(code);
};
backend.once("exit", (code) => {
  if (!stopping) {
    console.error(`Workspace backend stopped (${code}); local data is preserved.`);
    void stop(code || 1);
  }
});
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
