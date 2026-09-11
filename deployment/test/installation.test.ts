import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Output from "alchemy/Output";
import { beforeEach, describe, expect, it } from "vitest";
import { GsvDeployment, type GsvDeploymentProps } from "../src/installation.ts";
import { GsvRuntime, type GsvRuntimeDependencies } from "../src/runtime.ts";
import { StandaloneGsvDeployment } from "../src/standalone.ts";

type RecordedWorker = { id: string; props: Cloudflare.Workers.WorkerProps<Cloudflare.Workers.WorkerBindingProps> };
type RecordedBinding = { id: string; bindings: readonly { name: string; entrypoint?: string; props?: { authority?: string }; json?: unknown }[] };
type DeploymentRecorder = { workers: RecordedWorker[]; databases: { name: string; migrationsDir?: string; migrationsTable?: string }[]; bindings: RecordedBinding[] };
const recorded: DeploymentRecorder = { workers: [], databases: [], bindings: [] };
const recordedCloudflare = {
  ...Cloudflare,
  Worker(id: string, props: RecordedWorker["props"]) {
    recorded.workers.push({ id, props });
    return Effect.succeed({ workerName: props.name ?? id, url: `https://${id}.invalid`,
      durableObjectNamespaces: { Kernel: "1".repeat(32), Process: "2".repeat(32), Conversation: "3".repeat(32),
        Repository: "4".repeat(32), InferenceExecutor: "5".repeat(32), TelegramInstallation: "6".repeat(32) },
      bind(bindingId: string, input: Omit<RecordedBinding, "id">) { recorded.bindings.push({ id: bindingId, ...input }); return Effect.void; } });
  },
  D1: { Database(_id: string, props: typeof recorded.databases[number]) { recorded.databases.push(props); return Effect.succeed({ databaseId: "fixture-database" }); } },
  R2: { Bucket(_id: string, props: { name: string }) { return Effect.succeed({ bucketName: props.name }); } },
  DurableObject(binding: string, props: { className: string }) { return { binding, ...props }; },
  WorkerLoader() { return { kind: "loader" }; },
  WorkerEntrypoint(worker: { workerName: string }, options: string | { entrypoint: string; props: { authority: string } }) { return { worker: worker.workerName, options }; },
  Workers: { AI() { return { kind: "ai" }; } },
};
// SAFETY: this injected recorder implements every constructor/bind operation used
// by these compositions, returns local Effects, and never invokes a provider.
// oxlint-disable-next-line anti-slop/no-chained-type-assertions -- The injected test recorder intentionally omits Alchemy provider metadata; only the exercised constructor/bind surface is implemented.
const dependencies = { Cloudflare: recordedCloudflare, Effect, retain: () => <T>(value: T): T => value } as unknown as GsvRuntimeDependencies;
function run<A, E, R>(effect: Effect.Effect<A, E, R>): Promise<A> {
  // SAFETY: all resource construction below uses the injected local recorder,
  // so these Effects have no Cloudflare provider services at runtime.
  return Effect.runPromise(effect as Effect.Effect<A, E>);
}
beforeEach(() => { recorded.workers.length = 0; recorded.databases.length = 0; recorded.bindings.length = 0; });

const input: GsvDeploymentProps = {
  logicalPrefix: "Fixture", domain: "example.com", adminOrigin: "https://accounts.example.com", access: { kind: "operator" },
  names: { gateway: "gateway", ripgit: "ripgit", storageBucket: "storage" },
  paths: { gatewayBundle: "gateway.js", webAssets: "assets", ripgitBundle: "ripgit.js" },
  installations: { workerName: "directory", databaseName: "directory-db", workerBundle: "installations.js", migrationsDirectory: "public/migrations" },
  inference: { workerName: "inference", workerBundle: "inference.js", defaultProvider: "operator-provider", defaultModel: "operator-model",
    monthlyRequests: 100, monthlyOutputTokens: 1000, maxOutputTokens: 100, maxDurationMs: 10_000 },
};

describe("public operator composition", () => {
  it("provisions a fresh directory and executor with the exact recovery authority bindings", async () => {
    await run(GsvDeployment(input, dependencies));
    expect(recorded.databases).toEqual([{ name: "directory-db", migrationsDir: "public/migrations", migrationsTable: "installation_migrations" }]);
    const gateway = recorded.workers.find((worker) => worker.id === "FixtureGateway")?.props.env;
    expect(gateway).toHaveProperty("INFERENCE_EXECUTION");
    expect(gateway).not.toHaveProperty("AI");
    expect(gateway).not.toHaveProperty("MANAGED_INFERENCE");
    expect(gateway).not.toHaveProperty("MANAGED_INFERENCE_INSTALLATIONS");
    expect(gateway?.INSTALLATION_OWNERSHIP).toEqual({ worker: "directory",
      options: { entrypoint: "InstallationOwnershipEntrypoint", props: { authority: "kernel-owner-link" } } });
    expect(recorded.bindings).toContainEqual({ id: "FixtureDirectoryRecoveryBinding", bindings: [{ type: "service",
      name: "ACCOUNTS_GATEWAY_RECOVERY", service: "gateway", entrypoint: "GatewayRecoveryEntrypoint",
      props: { authority: "installation-owner-recovery" } }] });
    expect(recorded.bindings).toContainEqual({ id: "FixtureDirectoryGatewayDeletionBinding", bindings: [{ type: "service",
      name: "DELETION_OWNER_GATEWAY", service: "gateway", entrypoint: "GatewayLifecycleEntrypoint",
      props: { authority: "installation-deletion" } }] });
    expect(recorded.bindings).toContainEqual({ id: "FixtureDirectoryInferenceDeletionBinding", bindings: [{ type: "service",
      name: "DELETION_OWNER_INFERENCE", service: "inference", entrypoint: "InferenceLifecycleEntrypoint",
      props: { authority: "installation-deletion" } }] });
    expect(recorded.workers.find((worker) => worker.id === "FixtureInstallations")?.props.crons).toEqual(["* * * * *"]);
    const inference = recorded.workers.find((worker) => worker.id === "FixtureInference")?.props.env;
    expect(inference?.INFERENCE_EXECUTORS).toEqual({ binding: "INFERENCE_EXECUTORS", className: "InferenceExecutor" });
    expect(inference?.INFERENCE_DEFAULT_MODEL).toBe("operator-model");
    const discovery = recorded.bindings.find((binding) => binding.id === "FixtureDirectoryDeletionDiscoveryBinding");
    expect(await run(Output.evaluate(discovery?.bindings[0].json, {}))).toEqual({
      ["1".repeat(32)]: { ownerId: "gateway", kind: "kernel" },
      ["2".repeat(32)]: { ownerId: "gateway", kind: "process" },
      ["3".repeat(32)]: { ownerId: "gateway", kind: "conversation" },
      ["4".repeat(32)]: { ownerId: "gateway", kind: "ripgit" },
      ["5".repeat(32)]: { ownerId: "inference", kind: "inference-executor" },
    });
  });

  it("uses supplied operator services without creating a D1 or replacing either service", async () => {
    const directory = await run(dependencies.Cloudflare.Worker("ProvidedDirectory", { name: "existing-directory", main: "provided.js" }));
    const executor = await run(dependencies.Cloudflare.Worker("ProvidedExecutor", { name: "existing-executor", main: "provided.js" }));
    recorded.workers.length = 0;
    await run(GsvDeployment({ ...input, services: { installationDirectory: directory, inferenceExecution: executor } }, dependencies));
    expect(recorded.databases).toEqual([]);
    expect(recorded.workers.map((worker) => worker.id)).toEqual(["FixtureRipgit", "FixtureGateway"]);
    expect(recorded.workers[1].props.env?.INFERENCE_EXECUTION).toBe(executor);
  });

  it("binds adapter cleanup to Accounts with the exact deployment-owned authority", async () => {
    const adapter = await run(dependencies.Cloudflare.Worker("Telegram", { name: "telegram", main: "telegram.js" }));
    await run(GsvDeployment({ ...input, services: { adapters: [{ id: "telegram", worker: adapter,
      gatewayBinding: "CHANNEL_TELEGRAM", gatewayEntrypoint: "ManagedTelegramChannel",
      lifecycle: { entrypoint: "TelegramLifecycleEntrypoint", namespaces: [
        { className: "TelegramInstallation", kind: "adapter-installation" },
      ] },
    }] } }, dependencies));
    expect(recorded.bindings).toContainEqual({ id: "FixturetelegramDeletionBinding", bindings: [{ type: "service",
      name: "DELETION_OWNER_TELEGRAM", service: "telegram", entrypoint: "TelegramLifecycleEntrypoint",
      props: { authority: "installation-deletion" } }] });
    expect(recorded.bindings).toContainEqual({ id: "FixturetelegramGatewayBinding", bindings: [
      { type: "service", name: "ACCOUNTS", service: "directory" },
      { type: "service", name: "GATEWAY", service: "gateway", entrypoint: "AdapterGatewayEntrypoint",
        props: { id: "telegram", calls: ["adapter.inbound", "adapter.state.update"] } },
    ] });
    const discovery = recorded.bindings.find((binding) => binding.id === "FixtureDirectoryDeletionDiscoveryBinding");
    expect(await run(Output.evaluate(discovery?.bindings[0].json, {}))).toHaveProperty("6".repeat(32), {
      ownerId: "telegram", kind: "adapter-installation",
    });
  });

  it("refuses an adapter without a cleanup owner before allocating runtime storage", async () => {
    const directory = await run(dependencies.Cloudflare.Worker("Directory", { name: "directory", main: "directory.js" }));
    const executor = await run(dependencies.Cloudflare.Worker("Inference", { name: "inference", main: "inference.js" }));
    const adapter = await run(dependencies.Cloudflare.Worker("Telegram", { name: "telegram", main: "telegram.js" }));
    recorded.workers.length = 0;
    await expect(run(GsvRuntime({ ...input, mode: "managed", services: { installationDirectory: directory,
      inferenceExecution: executor, adapters: [{ id: "telegram", worker: adapter,
        gatewayBinding: "CHANNEL_TELEGRAM", gatewayEntrypoint: "ManagedTelegramChannel" }] } }, dependencies)))
      .rejects.toThrow(/requires an owned lifecycle/);
    expect(recorded.workers).toEqual([]);
  });

  it("refuses missing required services before creating runtime resources", async () => {
    await expect(run(GsvRuntime({ ...input, mode: "managed", services: {} }, dependencies))).rejects.toThrow(/requires an installation directory/);
    expect(recorded.workers).toEqual([]);
    expect(recorded.databases).toEqual([]);
    await expect(run(StandaloneGsvDeployment({ manifest: { version: 2, runtime: { ...input.paths,
      installationsBundle: "installations.js", installationsMigrations: "migrations", inferenceBundle: "inference.js" }, adapters: [] }, adapterIds: [] })))
      .rejects.toThrow(/migrate existing state/);
  });
});
