import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Output from "alchemy/Output";
import * as Redacted from "effect/Redacted";
import { beforeEach, describe, expect, it } from "vitest";
import { GsvDeployment, type GsvDeploymentProps } from "../src/installation.ts";
import { GsvRuntime, type GsvRuntimeDependencies } from "../src/runtime.ts";
import { StandaloneGsvDeployment } from "../src/standalone.ts";
import type { OperatorResourceCatalog } from "../src/deletion-bindings.ts";

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
  Queues: { Queue(_id: string, props: { name: string }) { return Effect.succeed({ queueName: props.name, queueId: "fixture-queue" }); } },
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
const catalog: OperatorResourceCatalog = [
  { id: "multipart", kind: "r2", namespace: "storage", source: "cloudflare-r2-multipart", scope: "installation", disposition: "live" },
  { id: "gateway-logs", kind: "logs", namespace: "gateway", source: "cloudflare-workers-logs", scope: "installation", disposition: "retained" },
  { id: "ripgit-logs", kind: "logs", namespace: "ripgit", source: "cloudflare-workers-logs", scope: "installation", disposition: "retained" },
  { id: "workers-ai", kind: "provider", namespace: "workers-ai", source: "provider", scope: "installation", disposition: "retained" },
  { id: "ai-gateway", kind: "provider", namespace: "default", source: "ai-gateway", scope: "installation", disposition: "retained" },
  { id: "default-provider", kind: "provider", namespace: "operator-provider", source: "provider", scope: "installation", disposition: "retained" },
];

describe("public operator composition", () => {
  it.each([
    { monthlyRequests: 0, monthlyOutputTokens: 1000 },
    { monthlyRequests: 100, monthlyOutputTokens: 0 },
    { monthlyRequests: 0, monthlyOutputTokens: 0 },
  ])("passes unlimited monthly quotas through to the executor: $monthlyRequests requests, $monthlyOutputTokens tokens", async (monthly) => {
    await run(GsvDeployment({ ...input, inference: { ...input.inference, ...monthly } }, dependencies));
    expect(recorded.workers.find((worker) => worker.id === "FixtureInference")?.props.env).toMatchObject({
      INFERENCE_MONTHLY_REQUESTS: monthly.monthlyRequests,
      INFERENCE_MONTHLY_OUTPUT_TOKENS: monthly.monthlyOutputTokens,
      INFERENCE_MAX_OUTPUT_TOKENS: input.inference.maxOutputTokens,
      INFERENCE_MAX_DURATION_MS: input.inference.maxDurationMs,
    });
  });

  it.each(["monthlyRequests", "monthlyOutputTokens", "maxOutputTokens", "maxDurationMs"] as const)(
    "rejects invalid %s before creating resources", async (field) => {
      for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        await expect(run(GsvDeployment({ ...input, inference: { ...input.inference, [field]: value } }, dependencies)))
          .rejects.toThrow(/safe integers/);
        expect(recorded.workers).toEqual([]);
        expect(recorded.databases).toEqual([]);
      }
    });

  it.each(["maxOutputTokens", "maxDurationMs"] as const)("rejects zero %s even with unlimited monthly quotas", async (field) => {
    await expect(run(GsvDeployment({ ...input, inference: { ...input.inference,
      monthlyRequests: 0, monthlyOutputTokens: 0, [field]: 0,
    } }, dependencies))).rejects.toThrow(/per-request limits must be positive safe integers/);
    expect(recorded.workers).toEqual([]);
    expect(recorded.databases).toEqual([]);
  });

  it("binds restricted owner email and the stable redacted secret only to Accounts", async () => {
    const authSecret = Redacted.make("synthetic-stable-owner-secret");
    await run(GsvDeployment({ ...input, installations: { ...input.installations,
      ownerIdentity: { issuer: "https://identity.example.com", clientId: "owner-client" },
      ownerEmail: { from: "accounts@example.com", allowedRecipients: ["owner@example.com"], authSecret },
    } }, dependencies));
    const accounts = recorded.workers.find((worker) => worker.id === "FixtureInstallations")!.props.env!;
    expect(accounts.GSV_OWNER_EMAIL_FROM).toBe("accounts@example.com");
    expect(accounts.GSV_OWNER_AUTH_SECRET).toBe(authSecret);
    expect(JSON.stringify(accounts.GSV_OWNER_AUTH_SECRET)).not.toContain("synthetic-stable-owner-secret");
    expect(accounts.GSV_OWNER_OIDC_CLIENT_ID).toBe("owner-client");
    if (!Effect.isEffect(accounts.OWNER_EMAIL)) throw new Error("Expected native email binding");
    expect(await run(accounts.OWNER_EMAIL)).toMatchObject({
      kind: "Cloudflare.Email.SendEmail", name: "OWNER_EMAIL",
      allowedSenderAddresses: ["accounts@example.com"], allowedDestinationAddresses: ["owner@example.com"],
    });
    for (const worker of recorded.workers.filter((worker) => worker.id !== "FixtureInstallations")) {
      expect(worker.props.env).not.toHaveProperty("OWNER_EMAIL");
      expect(worker.props.env).not.toHaveProperty("GSV_OWNER_AUTH_SECRET");
    }
  });

  it("does not configure owner email when no sender has been selected", async () => {
    await run(GsvDeployment(input, dependencies));
    const accounts = recorded.workers.find((worker) => worker.id === "FixtureInstallations")!.props.env!;
    expect(accounts).not.toHaveProperty("OWNER_EMAIL");
    expect(accounts).not.toHaveProperty("GSV_OWNER_EMAIL_FROM");
    expect(accounts).not.toHaveProperty("GSV_OWNER_AUTH_SECRET");
  });

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
    expect(recorded.bindings.some((binding) => binding.id === "FixtureDirectoryDeletionResourcesBinding")).toBe(false);
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

  it("derives application scopes while keeping external cleanup explicitly unknown", async () => {
    await run(GsvDeployment({ ...input, deletion: { operatorResources: catalog } }, dependencies));
    const binding = recorded.bindings.find((binding) => binding.id === "FixtureDirectoryDeletionResourcesBinding");
    const scopes = binding?.bindings.find((entry) => entry.name === "DELETION_RESOURCE_SCOPES");
    expect(await run(Output.evaluate(scopes?.json, {}))).toEqual({
      accounts: [{ kind: "d1", namespace: "fixture-database" }], gateway: [{ kind: "r2", namespace: "storage" }],
      inference: [], "operator-resources": catalog.map(({ kind, namespace }) => ({ kind, namespace })),
    });
    expect(binding?.bindings.find((entry) => entry.name === "OPERATOR_DELETION_CATALOG")?.json).toEqual(catalog);
  });

  it("refuses an external inventory that omits the application's multipart uploads", async () => {
    await run(GsvDeployment({ ...input, deletion: { operatorResources: catalog.filter((resource) => resource.id !== "multipart") } }, dependencies));
    const binding = recorded.bindings.find((binding) => binding.id === "FixtureDirectoryDeletionResourcesBinding");
    const scopes = binding?.bindings.find((entry) => entry.name === "DELETION_RESOURCE_SCOPES");
    await expect(run(Output.evaluate(scopes?.json, {}))).rejects.toThrow(/multipart uploads/);
  });

  it.each(["gateway-logs", "ripgit-logs", "workers-ai", "ai-gateway", "default-provider"])("rejects a catalog missing the known %s sink", async (id) => {
    await expect(run(GsvDeployment({ ...input, deletion: { operatorResources: catalog.filter((resource) => resource.id !== id) } }, dependencies)))
      .rejects.toThrow(/catalog does not cover/);
    expect(recorded.workers).toEqual([]);
    expect(recorded.databases).toEqual([]);
  });

  it("requires explicit owner composition for adopted directory, inference or Mail services", async () => {
    const worker = await run(dependencies.Cloudflare.Worker("Provided", { name: "provided", main: "provided.js" }));
    const queue = await run(dependencies.Cloudflare.Queues.Queue("Mail", { name: "mail" }));
    recorded.workers.length = 0;
    for (const services of [{ installationDirectory: worker }, { inferenceExecution: worker }, { mailOutbound: queue }]) {
      await expect(run(GsvDeployment({ ...input, services, deletion: { operatorResources: catalog } }, dependencies)))
        .rejects.toThrow(/adopted operator composition/);
    }
    expect(recorded.workers).toEqual([]);
    expect(recorded.databases).toEqual([]);
  });

  it("does not invent persisted log scopes when the fresh runtime explicitly disables persistence", async () => {
    const external = catalog.filter((resource) => resource.source !== "cloudflare-workers-logs");
    const observability = { enabled: true, logs: { enabled: true, invocationLogs: false, persist: false }, traces: { enabled: false } };
    await run(GsvDeployment({ ...input, observability, deletion: { operatorResources: external } }, dependencies));
    expect(recorded.workers.find((worker) => worker.id === "FixtureGateway")?.props.observability).toEqual(observability);
    expect(recorded.workers.find((worker) => worker.id === "FixtureRipgit")?.props.observability).toEqual(observability);
    const binding = recorded.bindings.find((binding) => binding.id === "FixtureDirectoryDeletionResourcesBinding");
    expect(await run(Output.evaluate(binding?.bindings.find((entry) => entry.name === "DELETION_RESOURCE_SCOPES")?.json, {})))
      .toHaveProperty("operator-resources", external.map(({ kind, namespace }) => ({ kind, namespace })));
  });

  it("matches a custom default provider by its configured endpoint", async () => {
    const inference = { ...input.inference, baseUrl: "https://provider.example.invalid/v1" };
    await expect(run(GsvDeployment({ ...input, inference, deletion: { operatorResources: catalog } }, dependencies)))
      .rejects.toThrow(/configured provider scope/);
    const external = catalog.map((resource) => resource.id === "default-provider" ? { ...resource, namespace: inference.baseUrl } : resource);
    await run(GsvDeployment({ ...input, inference, deletion: { operatorResources: external } }, dependencies));
    expect(recorded.workers.find((worker) => worker.id === "FixtureInference")?.props.env?.INFERENCE_BASE_URL).toBe(inference.baseUrl);
  });

  it("normalizes the actual Workers AI alias without inventing another provider", async () => {
    await run(GsvDeployment({ ...input, inference: { ...input.inference, defaultProvider: "workersai" },
      deletion: { operatorResources: catalog.filter((resource) => resource.id !== "default-provider") } }, dependencies));
    expect(recorded.workers.find((worker) => worker.id === "FixtureInference")?.props.env?.INFERENCE_DEFAULT_PROVIDER).toBe("workersai");
  });

  it("requires the actual adapter Worker log scope with its application owner", async () => {
    const worker = await run(dependencies.Cloudflare.Worker("Telegram", { name: "telegram-worker", main: "telegram.js" }));
    const services = { adapters: [{ id: "telegram", worker, gatewayBinding: "CHANNEL_TELEGRAM", gatewayEntrypoint: "ManagedTelegramChannel",
      lifecycle: { entrypoint: "TelegramLifecycleEntrypoint", namespaces: [{ className: "TelegramInstallation", kind: "adapter-installation" as const }] },
    }] };
    await run(GsvDeployment({ ...input, services, deletion: { operatorResources: catalog } }, dependencies));
    const binding = recorded.bindings.find((binding) => binding.id === "FixtureDirectoryDeletionResourcesBinding");
    await expect(run(Output.evaluate(binding?.bindings.find((entry) => entry.name === "DELETION_RESOURCE_SCOPES")?.json, {})))
      .rejects.toThrow(/configured cloudflare-workers-logs scope/);
    recorded.bindings.length = 0;
    await run(GsvDeployment({ ...input, services, deletion: { operatorResources: [...catalog,
      { id: "telegram-logs", kind: "logs", namespace: "telegram-worker", source: "cloudflare-workers-logs", scope: "installation", disposition: "retained" },
    ] } }, dependencies));
    const complete = recorded.bindings.find((binding) => binding.id === "FixtureDirectoryDeletionResourcesBinding");
    expect(await run(Output.evaluate(complete?.bindings.find((entry) => entry.name === "DELETION_RESOURCE_SCOPES")?.json, {}))).toHaveProperty("telegram", []);
  });
});
