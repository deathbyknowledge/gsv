import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Config from "effect/Config";
import * as Schema from "effect/Schema";
import * as Output from "alchemy/Output";
import * as Redacted from "effect/Redacted";
import { beforeEach, describe, expect, it } from "vitest";
import { GsvDeployment, type GsvDeploymentProps } from "../src/installation.ts";
import { GsvRuntime, type GsvRuntimeDependencies } from "../src/runtime.ts";
import { GsvAdapterWorker } from "../src/adapter.ts";
import { GsvDeletionResourceBindings, type OperatorResourceCatalog } from "../src/deletion-bindings.ts";

type RecordedWorker = { id: string; props: Cloudflare.Workers.WorkerProps<Cloudflare.Workers.WorkerBindingProps> };
type RecordedBinding = { id: string; bindings: readonly { name: string; entrypoint?: string; props?: { authority?: string; canonicalOrigin?: unknown }; json?: unknown }[] };
type RecordedRoute = { id: string; zoneId: string; pattern: string; script: unknown };
type DeploymentRecorder = { workers: RecordedWorker[]; databases: { name: string; migrations?: { dir: string; table: string } }[]; bindings: RecordedBinding[]; routes: RecordedRoute[] };
const recorded: DeploymentRecorder = { workers: [], databases: [], bindings: [], routes: [] };
const recordedCloudflare = {
  ...Cloudflare,
  Worker(id: string, props: RecordedWorker["props"]) {
    recorded.workers.push({ id, props });
    return Effect.succeed({ workerName: props.name ?? id, url: `https://${id}.invalid`,
      durableObjectNamespaces: { Kernel: "1".repeat(32), Process: "2".repeat(32), Conversation: "3".repeat(32),
        Repository: "4".repeat(32), InferenceExecutor: "5".repeat(32), TelegramInstallation: "6".repeat(32), WebSearchInstallation: "7".repeat(32),
        InstanceCoordinator: "8".repeat(32), ComputerInstance: "9".repeat(32), HostedRepo: "a".repeat(32), HostFirehose: "b".repeat(32) },
      bind(bindingId: string, input: Omit<RecordedBinding, "id">) { recorded.bindings.push({ id: bindingId, ...input }); return Effect.void; } });
  },
  D1: { Database(_id: string, props: typeof recorded.databases[number]) { recorded.databases.push(props); return Effect.succeed({ databaseId: "fixture-database" }); } },
  R2: { Bucket(_id: string, props: { name: string }) { return Effect.succeed({ bucketName: props.name }); } },
  Queues: { Queue(_id: string, props: { name: string }) { return Effect.succeed({ queueName: props.name, queueId: "fixture-queue" }); } },
  DurableObject(binding: string, props: { className: string }) { return { binding, ...props }; },
  WorkerLoader() { return { kind: "loader" }; },
  WorkerEntrypoint(worker: { workerName: string }, options: string | { entrypoint: string; props: { authority: string } }) { return { worker: worker.workerName, options }; },
  DNS: { Record() { return Effect.void; } },
  Workers: {
    AI() { return { kind: "ai" }; },
    WorkerRoute(id: string, props: Omit<RecordedRoute, "id">) { recorded.routes.push({ id, ...props }); return Effect.void; },
  },
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
beforeEach(() => { recorded.workers.length = 0; recorded.databases.length = 0; recorded.bindings.length = 0; recorded.routes.length = 0; });

it("attaches the operator tail to both runtime Workers and explicitly configured adapters", async () => {
  await run(GsvDeployment({ ...input, telemetry: { tailConsumers: ["test-tail"] } }, dependencies));
  for (const id of ["FixtureGateway", "FixtureRipgit"]) {
    expect(recorded.workers.find((worker) => worker.id === id)?.props.tailConsumers).toEqual(["test-tail"]);
  }
  const deployment = { main: "adapter.js", bundle: true, gatewayEntrypoint: "Adapter", adapterEntrypoint: "Adapter", durableObjects: [], requiredSecrets: [] };
  await run(GsvAdapterWorker({ logicalId: "Adapter", workerName: "adapter", tailConsumers: ["test-tail"],
    adapter: { id: "test", displayName: "Test", gatewayBinding: "CHANNEL_TEST", deployment }, deployment,
  }, { Cloudflare: dependencies.Cloudflare, Config, Schema, retain: dependencies.retain }));
  expect(recorded.workers.find((worker) => worker.id === "Adapter")?.props.tailConsumers).toEqual(["test-tail"]);
});

it("lets both runtime Workers report telemetry without persisting the logs that carry it", async () => {
  await run(GsvDeployment({ ...input, telemetry: { tailConsumers: ["test-tail"] } }, dependencies));
  for (const id of ["FixtureGateway", "FixtureRipgit"]) {
    const worker = recorded.workers.find((worker) => worker.id === id);
    expect(worker?.props.env?.GSV_TELEMETRY_ENABLED).toBe("1");
    expect(worker?.props.observability?.logs).toEqual({ enabled: true, invocationLogs: false, persist: false });
  }
  recorded.workers.length = 0;
  await run(GsvDeployment(input, dependencies));
  expect(recorded.workers.find((worker) => worker.id === "FixtureRipgit")?.props.env).not.toHaveProperty("GSV_TELEMETRY_ENABLED");
});

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
  it("passes public configuration and aliases to their owning services", async () => {
    const presentation = { operatorName: "Example operator", accountsOrigin: input.adminOrigin, docsUrl: "https://docs.example.com" };
    const operatorUpdates = { publisher: { id: "example", name: "Example operator" }, updates: [
      { id: "new-domain", publishedAtMs: 1000, title: "A new address", brief: "Your old address still works." },
    ] };
    await run(GsvDeployment({ ...input, domainAliases: ["old.example"], presentation, operatorUpdates,
      installations: { ...input.installations, ownerOriginAliases: ["https://join.example.com"] },
    }, dependencies));
    const accounts = recorded.workers.find((worker) => worker.id === "FixtureInstallations")!.props.env!;
    const gateway = recorded.workers.find((worker) => worker.id === "FixtureGateway")!.props.env!;
    expect(accounts.GSV_BASE_DOMAIN).toBe(input.domain);
    expect(JSON.parse(String(accounts.GSV_DOMAIN_ALIASES))).toEqual(["old.example"]);
    expect(JSON.parse(String(accounts.GSV_OWNER_ORIGIN_ALIASES))).toEqual(["https://join.example.com"]);
    const config = { ...presentation, primaryDomain: input.domain, legacyDomains: ["old.example"] };
    expect(JSON.parse(String(accounts.GSV_PUBLIC_CONFIG))).toEqual(config);
    expect(JSON.parse(String(gateway.GSV_PUBLIC_CONFIG))).toEqual(config);
    expect(JSON.parse(String(gateway.GSV_OPERATOR_UPDATES))).toEqual(operatorUpdates);
    expect(accounts).not.toHaveProperty("GSV_OPERATOR_UPDATES");
  });

  it("gives the Gateway its budget for calls between Ships", async () => {
    await run(GsvDeployment(input, dependencies));
    const gateway = recorded.workers.find((worker) => worker.id === "FixtureGateway")!.props.env!;
    expect(gateway.SHIP_CALLS).toMatchObject({ name: "SHIP_CALLS", namespaceId: "7001", simple: { limit: 250, period: 10 } });
  });

  it("routes a configured signup alias to Accounts alongside the administration hostname", async () => {
    await run(GsvDeployment({ ...input, routing: { zoneId: "zone" }, installations: {
      ...input.installations, ownerSignupOrigin: "https://join.example.com",
    } }, dependencies));
    expect(recorded.routes).toEqual([
      { id: "FixtureInstallationsRoute", zoneId: "zone", pattern: "accounts.example.com/*", script: "directory" },
      { id: "FixtureInstallationsSignupRoute", zoneId: "zone", pattern: "join.example.com/*", script: "directory" },
      { id: "FixtureGatewayRoute", zoneId: "zone", pattern: "*.example.com/*", script: "gateway" },
    ]);
    expect(recorded.workers.find((worker) => worker.id === "FixtureInstallations")?.props.env?.GSV_OWNER_SIGNUP_ORIGIN)
      .toBe("https://join.example.com");
  });

  it.each([
    { label: "a path", aliases: ["https://owners.example/path"] },
    { label: "HTTP", aliases: ["http://owners.example"] },
    { label: "credentials", aliases: ["https://user:password@owners.example"] },
    { label: "too many origins", aliases: Array.from({ length: 17 }, (_, index) => `https://owner-${index}.example`) },
  ])("rejects owner aliases with $label before allocating resources", async ({ aliases }) => {
    await expect(run(GsvDeployment({ ...input, installations: {
      ...input.installations, ownerOriginAliases: aliases,
    } }, dependencies))).rejects.toThrow();
    expect(recorded.workers).toEqual([]);
    expect(recorded.databases).toEqual([]);
  });

  it.each([undefined, input.adminOrigin])("does not duplicate Accounts routing for signup origin %s", async (ownerSignupOrigin) => {
    await run(GsvDeployment({ ...input, routing: { zoneId: "zone" }, installations: {
      ...input.installations, ownerSignupOrigin,
    } }, dependencies));
    expect(recorded.routes.map((route) => route.pattern)).toEqual(["accounts.example.com/*", "*.example.com/*"]);
  });

  it("leaves a separately hosted signup alias to the operator overlay when routing is omitted", async () => {
    await run(GsvDeployment({ ...input, installations: {
      ...input.installations, ownerSignupOrigin: "https://join.other.example",
    } }, dependencies));
    expect(recorded.routes).toEqual([]);
  });

  it.each(["http://join.example.com", "https://join.example.com/path", "https://join.other.example"])(
    "rejects an unroutable signup origin before allocating resources: %s", async (ownerSignupOrigin) => {
      await expect(run(GsvDeployment({ ...input, routing: { zoneId: "zone" }, installations: {
        ...input.installations, ownerSignupOrigin,
      } }, dependencies))).rejects.toThrow("Signup requires an HTTPS origin");
      expect(recorded.workers).toEqual([]);
      expect(recorded.databases).toEqual([]);
    });

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

  it.each([undefined, "hello@humansandmachin.es"])("binds restricted owner email with reply-to %s and the stable redacted secret only to Accounts", async (replyTo) => {
    const authSecret = Redacted.make("synthetic-stable-owner-secret");
    await run(GsvDeployment({ ...input, installations: { ...input.installations,
      ownerIdentity: { issuer: "https://identity.example.com", clientId: "owner-client" },
      ownerEmail: { from: "login@ship.space", replyTo, allowedRecipients: ["owner@example.com"], authSecret },
    } }, dependencies));
    const accounts = recorded.workers.find((worker) => worker.id === "FixtureInstallations")!.props.env!;
    expect(accounts.GSV_OWNER_EMAIL_FROM).toBe("login@ship.space");
    if (replyTo) expect(accounts.GSV_OWNER_EMAIL_REPLY_TO).toBe(replyTo);
    else expect(accounts).not.toHaveProperty("GSV_OWNER_EMAIL_REPLY_TO");
    expect(accounts.GSV_OWNER_AUTH_SECRET).toBe(authSecret);
    expect(JSON.stringify(accounts.GSV_OWNER_AUTH_SECRET)).not.toContain("synthetic-stable-owner-secret");
    expect(accounts.GSV_OWNER_OIDC_CLIENT_ID).toBe("owner-client");
    expect(recorded.workers.find((worker) => worker.id === "FixtureGateway")?.props.env?.GSV_OWNER_SIGNUP_URL)
      .toBe("https://accounts.example.com/owner/signup/?resume=1");
    if (!Effect.isEffect(accounts.OWNER_EMAIL)) throw new Error("Expected native email binding");
    expect(await run(accounts.OWNER_EMAIL)).toMatchObject({
      kind: "Cloudflare.Email.SendEmail", name: "OWNER_EMAIL",
      allowedSenderAddresses: ["login@ship.space"], allowedDestinationAddresses: ["owner@example.com"],
    });
    for (const worker of recorded.workers.filter((worker) => worker.id !== "FixtureInstallations")) {
      expect(worker.props.env).not.toHaveProperty("OWNER_EMAIL");
      expect(worker.props.env).not.toHaveProperty("GSV_OWNER_EMAIL_REPLY_TO");
      expect(worker.props.env).not.toHaveProperty("GSV_OWNER_AUTH_SECRET");
    }
  });

  it("does not configure owner email when no sender has been selected", async () => {
    await run(GsvDeployment(input, dependencies));
    const accounts = recorded.workers.find((worker) => worker.id === "FixtureInstallations")!.props.env!;
    expect(accounts).not.toHaveProperty("OWNER_EMAIL");
    expect(accounts).not.toHaveProperty("GSV_OWNER_EMAIL_FROM");
    expect(accounts).not.toHaveProperty("GSV_OWNER_EMAIL_REPLY_TO");
    expect(accounts).not.toHaveProperty("GSV_OWNER_AUTH_SECRET");
    expect(recorded.workers.find((worker) => worker.id === "FixtureGateway")?.props.env)
      .not.toHaveProperty("GSV_OWNER_SIGNUP_URL");
  });

  it("provisions a fresh directory and executor with the exact recovery authority bindings", async () => {
    await run(GsvDeployment(input, dependencies));
    expect(recorded.databases).toEqual([{ name: "directory-db", migrations: { dir: "public/migrations", table: "installation_migrations" } }]);
    const gatewayWorker = recorded.workers.find((worker) => worker.id === "FixtureGateway");
    expect(gatewayWorker?.props.compatibility).toMatchObject({ flags: expect.arrayContaining(["global_fetch_strictly_public"]) });
    const gateway = gatewayWorker?.props.env;
    expect(gateway).toHaveProperty("INFERENCE_EXECUTION");
    expect(gateway).not.toHaveProperty("AI");
    expect(gateway).not.toHaveProperty("MANAGED_INFERENCE");
    expect(gateway).not.toHaveProperty("MANAGED_INFERENCE_INSTALLATIONS");
    expect(gateway?.INSTALLATION_OWNERSHIP).toEqual({ worker: "directory",
      options: { entrypoint: "InstallationOwnershipEntrypoint", props: { authority: "kernel-owner-link" } } });
    expect(gateway?.REQUEST_REPORTS).toEqual({ worker: "directory",
      options: { entrypoint: "RequestReportsEntrypoint", props: { authority: "kernel-report" } } });
    expect(gateway?.INSTALLATION_OWNER_CONFIRMATIONS).toEqual({ worker: "directory",
      options: { entrypoint: "OwnerConfirmationsEntrypoint", props: { authority: "kernel-owner-confirmation" } } });
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
    const adapter = await run(dependencies.Cloudflare.Worker("Telegram", { name: "telegram", main: "telegram.js" }));
    recorded.workers.length = 0;
    await run(GsvDeployment({ ...input, services: { installationDirectory: directory, inferenceExecution: executor,
      inferenceLifecycle: { worker: executor, entrypoint: "ProvidedInferenceLifecycle", namespaces: [
        { className: "InferenceExecutor", kind: "inference-executor" },
      ] },
      adapters: [{ id: "telegram", worker: adapter, gatewayBinding: "CHANNEL_TELEGRAM", gatewayEntrypoint: "ManagedTelegramChannel",
        lifecycle: { entrypoint: "TelegramLifecycleEntrypoint", namespaces: [{ className: "TelegramInstallation", kind: "adapter-installation" }] } }],
    } }, dependencies));
    expect(recorded.databases).toEqual([]);
    expect(recorded.workers.map((worker) => worker.id)).toEqual(["FixtureRipgit", "FixtureGateway"]);
    expect(recorded.workers[1].props.env?.INFERENCE_EXECUTION).toBe(executor);
    expect(recorded.bindings).toContainEqual({ id: "FixtureDirectoryInferenceDeletionBinding", bindings: [{ type: "service",
      name: "DELETION_OWNER_INFERENCE", service: "existing-executor", entrypoint: "ProvidedInferenceLifecycle",
      props: { authority: "installation-deletion" } }] });
    const discovery = recorded.bindings.find((binding) => binding.id === "FixtureDirectoryDeletionDiscoveryBinding");
    expect(await run(Output.evaluate(discovery?.bindings[0].json, {}))).toEqual({
      ["1".repeat(32)]: { ownerId: "gateway", kind: "kernel" },
      ["2".repeat(32)]: { ownerId: "gateway", kind: "process" },
      ["3".repeat(32)]: { ownerId: "gateway", kind: "conversation" },
      ["4".repeat(32)]: { ownerId: "gateway", kind: "ripgit" },
      ["5".repeat(32)]: { ownerId: "inference", kind: "inference-executor" },
      ["6".repeat(32)]: { ownerId: "telegram", kind: "adapter-installation" },
    });
  });

  it("rejects supplied execution without a cleanup owner before creating resources", async () => {
    const executor = await run(dependencies.Cloudflare.Worker("ProvidedExecutor", { name: "existing-executor", main: "provided.js" }));
    recorded.workers.length = 0;
    await expect(run(GsvDeployment({ ...input, services: { inferenceExecution: executor } }, dependencies)))
      .rejects.toThrow("Supplied inference execution requires its owned lifecycle");
    expect(recorded.workers).toEqual([]);
    expect(recorded.databases).toEqual([]);
  });

  it("binds supplied search cleanup and discovers its installation namespace", async () => {
    const search = await run(dependencies.Cloudflare.Worker("Search", { name: "search-provider", main: "search.js" }));
    await run(GsvDeployment({ ...input, services: {
      webSearch: search,
      webSearchLifecycle: { worker: search, entrypoint: "SearchLifecycle", namespaces: [
        { className: "WebSearchInstallation", kind: "web-search-installation" },
      ] },
    } }, dependencies));
    expect(recorded.workers.find((worker) => worker.id === "FixtureGateway")?.props.env?.WEB_SEARCH).toBe(search);
    expect(recorded.bindings).toContainEqual({ id: "FixtureDirectoryWebSearchDeletionBinding", bindings: [{ type: "service",
      name: "DELETION_OWNER_WEB_SEARCH", service: "search-provider", entrypoint: "SearchLifecycle",
      props: { authority: "installation-deletion" } }] });
    const discovery = recorded.bindings.find((binding) => binding.id === "FixtureDirectoryDeletionDiscoveryBinding");
    expect(await run(Output.evaluate(discovery?.bindings[0].json, {}))).toHaveProperty("7".repeat(32), {
      ownerId: "web-search", kind: "web-search-installation",
    });
  });

  it("requires and binds an instance cleanup owner", async () => {
    const instances = await run(dependencies.Cloudflare.Worker("Instances", { name: "instances-provider", main: "instances.js" }));
    await expect(run(GsvDeployment({ ...input, services: { instances } }, dependencies))).rejects.toThrow("owned lifecycle");
    await run(GsvDeployment({ ...input, services: { instances, instancesLifecycle: {
      worker: instances, entrypoint: "InstanceLifecycleEntrypoint", namespaces: [
        { className: "InstanceCoordinator", kind: "instance-installation" },
        { className: "ComputerInstance", kind: "instance-computer" },
      ],
    } } }, dependencies));
    expect(recorded.workers.find(worker => worker.id === "FixtureGateway")?.props.env?.INSTANCES).toBe(instances);
    expect(recorded.bindings).toContainEqual({ id: "FixtureDirectoryInstancesDeletionBinding", bindings: [{ type: "service",
      name: "DELETION_OWNER_INSTANCES", service: "instances-provider", entrypoint: "InstanceLifecycleEntrypoint", props: { authority: "installation-deletion" } }] });
    const discovery = recorded.bindings.find(binding => binding.id === "FixtureDirectoryDeletionDiscoveryBinding");
    expect(await run(Output.evaluate(discovery?.bindings[0].json, {}))).toMatchObject({
      ["8".repeat(32)]: { ownerId: "instances", kind: "instance-installation" },
      ["9".repeat(32)]: { ownerId: "instances", kind: "instance-computer" },
    });
  });

  it("rejects incomplete or unrelated instance namespace ownership before creating resources", async () => {
    const instances = await run(dependencies.Cloudflare.Worker("Instances", { name: "instances-provider", main: "instances.js" }));
    recorded.workers.length = 0;
    for (const namespaces of [
      [],
      [{ className: "InstanceCoordinator", kind: "instance-installation" }],
      [{ className: "ComputerInstance", kind: "instance-computer" }],
      [{ className: "SameObject", kind: "instance-installation" }, { className: "SameObject", kind: "instance-computer" }],
      [{ className: "", kind: "instance-computer" }],
      [{ className: "ComputerInstance", kind: "kernel" }],
    ]) {
      // SAFETY: These intentionally invalid namespace declarations exercise runtime configuration validation.
      const instancesLifecycle = { worker: instances, entrypoint: "InstanceLifecycleEntrypoint", namespaces } as NonNullable<GsvDeploymentProps["services"]>["instancesLifecycle"];
      await expect(run(GsvDeployment({ ...input, services: { instances, instancesLifecycle } }, dependencies)))
        .rejects.toThrow("valid instance namespace ownership");
      expect(recorded.workers).toEqual([]);
      expect(recorded.databases).toEqual([]);
    }
  });

  it("rejects incomplete search ownership before creating deployment resources", async () => {
    const search = await run(dependencies.Cloudflare.Worker("Search", { name: "search-provider", main: "search.js" }));
    recorded.workers.length = 0;
    const lifecycle = { worker: search, entrypoint: "SearchLifecycle", namespaces: [
      { className: "WebSearchInstallation", kind: "web-search-installation" as const },
    ] };
    for (const services of [
      { webSearch: search },
      { webSearchLifecycle: lifecycle },
      { webSearch: search, webSearchLifecycle: { ...lifecycle, entrypoint: " " } },
      { webSearch: search, webSearchLifecycle: { ...lifecycle, namespaces: [{ className: "", kind: "web-search-installation" as const }] } },
    ]) {
      await expect(run(GsvDeployment({ ...input, services }, dependencies))).rejects.toThrow(/Supplied web search/);
      expect(recorded.workers).toEqual([]);
      expect(recorded.databases).toEqual([]);
    }
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
    await expect(run(GsvRuntime({ ...input, services: { installationDirectory: directory,
      inferenceExecution: executor, adapters: [{ id: "telegram", worker: adapter,
        gatewayBinding: "CHANNEL_TELEGRAM", gatewayEntrypoint: "ManagedTelegramChannel" }] } }, dependencies)))
      .rejects.toThrow(/requires an owned lifecycle/);
    expect(recorded.workers).toEqual([]);
  });

  it("refuses missing required services before creating runtime resources", async () => {
    await expect(run(GsvRuntime({ ...input, services: { installationDirectory: undefined!, inferenceExecution: undefined! } }, dependencies))).rejects.toThrow(/requires an installation directory/);
    expect(recorded.workers).toEqual([]);
    expect(recorded.databases).toEqual([]);
  });

  it("refuses the local federation setting in a deployed runtime", async () => {
    const directory = await run(dependencies.Cloudflare.Worker("Directory", { name: "directory", main: "directory.js" }));
    const executor = await run(dependencies.Cloudflare.Worker("Inference", { name: "inference", main: "inference.js" }));
    recorded.workers.length = 0;
    await expect(run(GsvRuntime({ ...input, services: { installationDirectory: directory,
      inferenceExecution: executor, extraBindings: { GSV_FEDERATION_LOCAL_DEVELOPMENT: "1" } } }, dependencies)))
      .rejects.toThrow("only available in the development configuration");
    expect(recorded.workers).toEqual([]);
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

  it("requires browser storage and multipart inventory to use the same installation prefix", async () => {
    const directory = await run(dependencies.Cloudflare.Worker("Directory", { name: "directory", main: "directory.js" }));
    const scopes = { accounts: [], gateway: [], inference: [], instances: [
      { kind: "r2" as const, namespace: "browser-profiles", r2Prefix: "installation-root" as const },
    ] };
    const browser: OperatorResourceCatalog[number] = { id: "browser-multipart", kind: "r2", namespace: "browser-profiles",
      source: "cloudflare-r2-multipart", scope: "installation", disposition: "live" };
    await run(GsvDeletionResourceBindings("WrongPrefix", directory, scopes, [browser]));
    const wrong = recorded.bindings.find(binding => binding.id === "WrongPrefix")!.bindings.find(entry => entry.name === "DELETION_RESOURCE_SCOPES");
    await expect(run(Output.evaluate(wrong?.json, {}))).rejects.toThrow(/multipart uploads/);
    browser.r2Prefix = "installation-root";
    await run(GsvDeletionResourceBindings("BrowserPrefix", directory, scopes, [browser]));
    const correct = recorded.bindings.find(binding => binding.id === "BrowserPrefix")!.bindings.find(entry => entry.name === "DELETION_RESOURCE_SCOPES");
    expect(await run(Output.evaluate(correct?.json, {}))).toMatchObject({
      instances: scopes.instances, "operator-resources": [{ kind: "r2", namespace: "browser-profiles", r2Prefix: "installation-root" }],
    });
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
    for (const services of [{ installationDirectory: worker }, { inferenceExecution: worker }, { mailOutbound: queue }, { webSearch: worker }]) {
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

describe("open network host", () => {
  const pds = { workerName: "pds", bucketName: "pds-blobs", workerBundle: "pds.js", origin: "https://pds.example.com",
    plcUrl: "https://plc.example.com", rotationKey: Redacted.make("synthetic-rotation-key"), recoveryKey: Redacted.make("did:key:zRecovery") };

  it("deploys the PDS at its reserved hostname and gives only the Kernel its publishing authority", async () => {
    await run(GsvDeployment({ ...input, routing: { zoneId: "zone" }, pds }, dependencies));
    const host = recorded.workers.find((worker) => worker.id === "FixturePds")!;
    expect(host.props).toMatchObject({ name: "pds", main: "pds.js", bundle: false, workersDev: false,
      compatibility: { flags: expect.arrayContaining(["nodejs_compat", "global_fetch_strictly_public"]) } });
    const env = host.props.env!;
    expect(env.REPOS).toEqual({ binding: "REPOS", className: "HostedRepo" });
    expect(env.FIREHOSE).toEqual({ binding: "FIREHOSE", className: "HostFirehose" });
    if (!Effect.isEffect(env.BLOBS)) throw new Error("Expected the PDS's own bucket");
    expect(await run(env.BLOBS)).toEqual({ bucketName: "pds-blobs" });
    expect(env).toMatchObject({ PDS_ORIGIN: pds.origin, PLC_URL: pds.plcUrl,
      PLC_ROTATION_KEY: pds.rotationKey, PLC_RECOVERY_KEY: pds.recoveryKey, INSTALLATION_DIRECTORY: { workerName: "directory" } });
    const gateway = recorded.workers.find((worker) => worker.id === "FixtureGateway")!.props.env!;
    expect(gateway.PDS).toEqual({ worker: "pds", options: { entrypoint: "PdsPublisherEntrypoint", props: { authority: "kernel-publish" } } });
    expect(gateway.PLC_URL).toBe(pds.plcUrl);
    for (const worker of recorded.workers.filter((worker) => worker.id !== "FixturePds")) {
      expect(worker.props.env).not.toHaveProperty("PLC_ROTATION_KEY");
      if (worker.id !== "FixtureGateway") expect(worker.props.env).not.toHaveProperty("PDS");
    }
    expect(recorded.routes).toContainEqual({ id: "FixturePdsRoute", zoneId: "zone", pattern: "pds.example.com/*", script: "pds" });
  });

  it("tells the network the operator's contact and policies when the operator gives them", async () => {
    await run(GsvDeployment({ ...input, routing: { zoneId: "zone" }, pds: { ...pds, contactEmail: "hello@example.com",
      privacyPolicyUrl: "https://example.com/privacy", termsOfServiceUrl: "https://example.com/terms" } }, dependencies));
    expect(recorded.workers.find((worker) => worker.id === "FixturePds")!.props.env).toMatchObject({
      PDS_CONTACT_EMAIL: "hello@example.com",
      PDS_PRIVACY_POLICY_URL: "https://example.com/privacy",
      PDS_TERMS_OF_SERVICE_URL: "https://example.com/terms",
    });
  });

  it("names no contact, policies, lexicon account or relays the operator didn't give", async () => {
    for (const relays of [undefined, []]) {
      recorded.workers.length = 0;
      await run(GsvDeployment({ ...input, routing: { zoneId: "zone" }, pds: { ...pds, relays } }, dependencies));
      const host = recorded.workers.find((worker) => worker.id === "FixturePds")!;
      for (const name of ["PDS_CONTACT_EMAIL", "PDS_PRIVACY_POLICY_URL", "PDS_TERMS_OF_SERVICE_URL", "PDS_LEXICON_HANDLE", "PDS_RELAYS"]) {
        expect(host.props.env).not.toHaveProperty(name);
      }
      expect(host.props.crons).toBeUndefined();
    }
  });

  it("tells the relays the operator names about the host, on a ten-minute schedule", async () => {
    await run(GsvDeployment({ ...input, routing: { zoneId: "zone" },
      pds: { ...pds, relays: ["https://relay-a.example", "https://relay-b.example"] } }, dependencies));
    const host = recorded.workers.find((worker) => worker.id === "FixturePds")!;
    expect(host.props.env).toMatchObject({ PDS_RELAYS: "https://relay-a.example,https://relay-b.example" });
    expect(host.props.crons).toEqual(["*/10 * * * *"]);
  });

  it("publishes lexicons on schedule from the account the operator names", async () => {
    await run(GsvDeployment({ ...input, routing: { zoneId: "zone" }, pds: { ...pds, lexiconHandle: "lexicons.example.com" } },
      dependencies));
    const host = recorded.workers.find((worker) => worker.id === "FixturePds")!;
    expect(host.props.env).toMatchObject({ PDS_LEXICON_HANDLE: "lexicons.example.com" });
    expect(host.props.crons).toEqual(["*/10 * * * *"]);
  });

  it("refuses a lexicon handle a Ship could take on a domain alias", async () => {
    await expect(run(GsvDeployment({ ...input, routing: { zoneId: "zone" }, domainAliases: ["old.example"],
      pds: { ...pds, lexiconHandle: "schemas.old.example" } }, dependencies))).rejects.toThrow("lexicons.<domain>");
    expect(recorded.workers).toEqual([]);
  });

  it("lets only Accounts' operator binding take down and restore what the PDS serves", async () => {
    await run(GsvDeployment({ ...input, routing: { zoneId: "zone" }, pds }, dependencies));
    const moderation = recorded.bindings.filter((binding) => binding.bindings.some((entry) => entry.entrypoint === "PdsModerationEntrypoint"));
    expect(moderation).toEqual([{ id: "FixtureDirectoryPdsModerationBinding", bindings: [{ type: "service",
      name: "PDS_MODERATION", service: "pds", entrypoint: "PdsModerationEntrypoint", props: { authority: "operator-moderation" } }] }]);
  });

  it("runs no PDS unless the operator configures one", async () => {
    await run(GsvDeployment({ ...input, routing: { zoneId: "zone" } }, dependencies));
    expect(recorded.workers.map((worker) => worker.id)).not.toContain("FixturePds");
    const gateway = recorded.workers.find((worker) => worker.id === "FixtureGateway")!.props.env!;
    expect(gateway).not.toHaveProperty("PDS");
    expect(gateway).not.toHaveProperty("PLC_URL");
    expect(recorded.routes.map((route) => route.pattern)).not.toContain("pds.example.com/*");
    expect(recorded.bindings.flatMap((binding) => binding.bindings).map((entry) => entry.name)).not.toContain("PDS_MODERATION");
  });

  it.each([
    { label: "another hostname", change: { origin: "https://repos.example.com" }, error: "pds.<domain>" },
    { label: "an HTTP origin", change: { origin: "http://pds.example.com" }, error: "HTTPS origins" },
    { label: "a directory with a path", change: { plcUrl: "https://plc.example.com/v1" }, error: "HTTPS origins" },
    { label: "a contact that isn't an email address", change: { contactEmail: "hello" }, error: "contact email" },
    { label: "an HTTP privacy policy", change: { privacyPolicyUrl: "http://example.com/privacy" }, error: "HTTPS URLs" },
    { label: "terms that aren't a URL", change: { termsOfServiceUrl: "terms" }, error: "HTTPS URLs" },
    { label: "a lexicon handle that isn't a domain name", change: { lexiconHandle: "Lexicons" }, error: "lowercase domain name" },
    { label: "a lexicon handle a Ship could take", change: { lexiconHandle: "schemas.example.com" }, error: "lexicons.<domain>" },
    { label: "an HTTP relay", change: { relays: ["http://relay.example"] }, error: "relays" },
    { label: "a relay with a path", change: { relays: ["https://relay.example/xrpc"] }, error: "relays" },
  ])("refuses a PDS at $label before allocating resources", async ({ change, error }) => {
    await expect(run(GsvDeployment({ ...input, routing: { zoneId: "zone" }, pds: { ...pds, ...change } }, dependencies)))
      .rejects.toThrow(error);
    expect(recorded.workers).toEqual([]);
    expect(recorded.databases).toEqual([]);
  });

  const pdsResources: OperatorResourceCatalog = [
    { id: "pds-multipart", kind: "r2", namespace: "pds-blobs", source: "cloudflare-r2-multipart", scope: "installation", disposition: "live" },
    { id: "pds-logs", kind: "logs", namespace: "pds", source: "cloudflare-workers-logs", scope: "installation", disposition: "retained" },
  ];

  it("lets Accounts delete each Ship's repository, host entries, files and DID through the PDS", async () => {
    await run(GsvDeployment({ ...input, pds, deletion: { operatorResources: [...catalog, ...pdsResources] } }, dependencies));
    expect(recorded.bindings).toContainEqual({ id: "FixtureDirectoryPdsDeletionBinding", bindings: [{ type: "service",
      name: "DELETION_OWNER_PDS", service: "pds", entrypoint: "PdsLifecycleEntrypoint",
      props: { authority: "installation-deletion" } }] });
    const discovery = recorded.bindings.find((binding) => binding.id === "FixtureDirectoryDeletionDiscoveryBinding");
    expect(await run(Output.evaluate(discovery?.bindings[0].json, {}))).toMatchObject({
      ["a".repeat(32)]: { ownerId: "pds", kind: "pds-repository" },
      ["b".repeat(32)]: { ownerId: "pds", kind: "pds-host" },
    });
    const resources = recorded.bindings.find((binding) => binding.id === "FixtureDirectoryDeletionResourcesBinding");
    expect(await run(Output.evaluate(resources?.bindings.find((entry) => entry.name === "DELETION_RESOURCE_SCOPES")?.json, {})))
      .toHaveProperty("pds", [{ kind: "r2", namespace: "pds-blobs" }]);
  });

  it("leaves the PDS's logs to the operator's tail, as the Gateway's are", async () => {
    const [multipart] = pdsResources;
    await run(GsvDeployment({ ...input, pds, telemetry: { tailConsumers: ["test-tail"] },
      deletion: { operatorResources: [...catalog, multipart] } }, dependencies));
    expect(recorded.workers.find((worker) => worker.id === "FixturePds")?.props).toMatchObject({ tailConsumers: ["test-tail"],
      observability: { logs: { invocationLogs: false, persist: false } } });
  });

  it("refuses deletion admission whose catalog omits the PDS's logs or unfinished uploads", async () => {
    const [multipart, logs] = pdsResources;
    await expect(run(GsvDeployment({ ...input, pds, deletion: { operatorResources: [...catalog, multipart] } }, dependencies)))
      .rejects.toThrow(/cloudflare-workers-logs scope/);
    expect(recorded.workers).toEqual([]);
    await run(GsvDeployment({ ...input, pds, deletion: { operatorResources: [...catalog, logs] } }, dependencies));
    const resources = recorded.bindings.find((binding) => binding.id === "FixtureDirectoryDeletionResourcesBinding");
    await expect(run(Output.evaluate(resources?.bindings.find((entry) => entry.name === "DELETION_RESOURCE_SCOPES")?.json, {})))
      .rejects.toThrow(/multipart uploads/);
  });

  it("refuses an invalid PDS in a runtime composed without GsvDeployment", async () => {
    const directory = await run(dependencies.Cloudflare.Worker("Directory", { name: "directory", main: "directory.js" }));
    const executor = await run(dependencies.Cloudflare.Worker("Inference", { name: "inference", main: "inference.js" }));
    recorded.workers.length = 0;
    await expect(run(GsvRuntime({ ...input, pds: { ...pds, plcUrl: "http://plc.example.com" },
      services: { installationDirectory: directory, inferenceExecution: executor } }, dependencies))).rejects.toThrow("HTTPS origins");
    expect(recorded.workers).toEqual([]);
  });
});
