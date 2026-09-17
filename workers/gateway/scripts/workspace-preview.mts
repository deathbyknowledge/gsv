import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { parseEnv } from "node:util";
import { createTestHarness, unstable_readConfig } from "wrangler";
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
  override async authorizeInstallationOnboarding(input: Parameters<Dependencies["authorizeInstallationOnboarding"]>[0]) {
    return super.authorizeInstallationOnboarding({ ...input, token: input.token === "onboard_integration_default_onboarding_token" ? "integration-onboarding-default" : input.token });
  }
}`);
dependencies.main = dependencyMain;
const inference = unstable_readConfig({ config: resolve(repo, "workers/inference/wrangler.dev.jsonc") }, { hideWarnings: true });
const inferenceConfig = resolve(temporary, "inference.jsonc");
await writeFile(inferenceConfig, JSON.stringify({
  name: "gsv-execution-test", main: resolve(repo, "workers/inference/src/index.ts"),
  compatibility_date: inference.compatibility_date, compatibility_flags: inference.compatibility_flags,
  alias, ai: { binding: "AI", remote: true },
  vars: inference.vars, durable_objects: inference.durable_objects, migrations: inference.migrations,
  services: [{ binding: "INSTALLATION_DIRECTORY", service: "gsv-test-dependencies" }],
}));
const harness = createTestHarness({ root: resolve(repo, "workers/gateway"), workers: [
  { config: gateway }, { config: dependencies },
  { configPath: inferenceConfig, secrets: { TYPESAFE_API_KEY: key } },
  { config: {
    name: "workspace-ripgit", main: ripgitMain, compatibility_date: "2026-07-29",
    durable_objects: { bindings: [{ name: "REPOSITORY", class_name: "Repository" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["Repository"] }],
  } },
] });
const { url } = await harness.listen();
const port = Number(process.env.GSV_WORKSPACE_PORT || 5184);
const origin = `http://localhost:${port}`;
// Set the development directory's canonical origin before the human creates the account.
const configured = await harness.getWorker("gsv-test-dependencies").fetch("/__test/default-origin", { method: "POST", body: origin });
await configured.body?.cancel();
if (!configured.ok) throw new Error("Could not prepare the local installation origin");
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
console.log(`Workspace preview: ${origin}/onboarding#onboard_integration_default_onboarding_token`);
console.log("Local disposable data; live Jev and generative inference begin only when you use the interface.");
const stop = async () => { await vite.close(); await harness.close(); await rm(temporary, { recursive: true, force: true }); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
