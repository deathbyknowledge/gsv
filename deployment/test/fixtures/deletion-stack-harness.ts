import { resolve } from "node:path";
import { vi } from "vitest";
import { createTestHarness, unstable_readConfig, type Unstable_RawConfig } from "wrangler";
import { FakePlcDirectory } from "../../../workers/pds/test/plc.ts";

export const PUBLIC_ROOT = resolve(import.meta.dirname, "../../..");
export const STACK = { gateway: "deletion-gateway", accounts: "deletion-accounts", inference: "deletion-inference",
  mail: "deletion-mail", ripgit: "deletion-ripgit", instances: "deletion-instances", pds: "deletion-pds", dependencies: "gsv-test-dependencies", evidence: "deletion-evidence" };
export const NAMESPACES = [
  { namespaceId: "1".repeat(32), ownerId: "gateway", kind: "kernel", worker: STACK.gateway, binding: "KERNEL" },
  { namespaceId: "2".repeat(32), ownerId: "gateway", kind: "process", worker: STACK.gateway, binding: "PROCESS" },
  { namespaceId: "3".repeat(32), ownerId: "gateway", kind: "conversation", worker: STACK.gateway, binding: "CONVERSATION" },
  { namespaceId: "4".repeat(32), ownerId: "inference", kind: "inference-executor", worker: STACK.inference, binding: "INFERENCE_EXECUTORS" },
  { namespaceId: "5".repeat(32), ownerId: "mail", kind: "mail", worker: STACK.mail, binding: "MAIL_INSTALLATIONS" },
  { namespaceId: "6".repeat(32), ownerId: "gateway", kind: "ripgit", worker: STACK.ripgit, binding: "REPOSITORY" },
  { namespaceId: "7".repeat(32), ownerId: "instances", kind: "instance-installation", worker: STACK.instances, binding: "INSTANCES" },
  { namespaceId: "8".repeat(32), ownerId: "pds", kind: "pds-repository", worker: STACK.pds, binding: "REPOS" },
  { namespaceId: "9".repeat(32), ownerId: "pds", kind: "pds-host", worker: STACK.pds, binding: "FIREHOSE" },
] as const;
export const SCOPES = { accounts: [{ kind: "d1", namespace: "accounts-db" }],
  gateway: [{ kind: "r2", namespace: "space-storage" }, { kind: "kv", namespace: "repository-registry" }], inference: [], mail: [],
  instances: [{ kind: "r2", namespace: "browser-profiles", r2Prefix: "installation-root" }],
  pds: [{ kind: "r2", namespace: "pds-blobs" }] } satisfies Record<string, { kind: "d1" | "r2" | "kv"; namespace: string; r2Prefix?: "installation-root" }[]>;
/** The DID directory the stack registers Ships with. */
export const TEST_PLC_URL = "https://plc.test";
const origin = "https://accounts.example.invalid";
const deletionProps = { authority: "installation-deletion" };
function config(path: string): Unstable_RawConfig { return unstable_readConfig({ config: resolve(PUBLIC_ROOT, path) }, { hideWarnings: true }); }

/**
 * The stack's Workers fetch through this process, so it serves their DID
 * directory. Nothing reaches plc.directory.
 */
export function serveTestPlc(): FakePlcDirectory {
  const plc = new FakePlcDirectory();
  const fetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin === "https://plc.directory") throw new Error("The deletion stack must not reach plc.directory");
    return url.origin === TEST_PLC_URL ? plc.handle(new Request(input, init)) : fetch(input, init);
  });
  return plc;
}

export function deletionStackHarness() {
  const gateway = config("workers/gateway/wrangler.jsonc");
  const lifecycle = config("workers/gateway/wrangler.managed.dev.jsonc");
  const accounts = config("workers/installations/wrangler.jsonc");
  const inference = config("workers/inference/wrangler.jsonc");
  const mail = config("workers/adapters/email/wrangler.test.jsonc");
  const instances = config("workers/instances/wrangler.test.jsonc");
  const pds = config("workers/pds/wrangler.jsonc");
  const dependencies = config("workers/gateway/test-integration/fixtures/wrangler.jsonc");
  const gatewayConfig: Unstable_RawConfig = {
    name: STACK.gateway, main: gateway.main, compatibility_date: gateway.compatibility_date,
    compatibility_flags: [...gateway.compatibility_flags ?? [], "enable_abortsignal_rpc"], define: gateway.define, rules: gateway.rules,
    migrations: lifecycle.migrations,
    durable_objects: { bindings: lifecycle.durable_objects!.bindings.filter((binding) => ["KERNEL", "PROCESS", "CONVERSATION"].includes(binding.name)) },
    r2_buckets: [{ binding: "STORAGE", bucket_name: "space-storage" }], assets: gateway.assets,
    worker_loaders: [{ binding: "LOADER" }],
    queues: { producers: [{ binding: "MANAGED_MAIL_OUTBOUND", queue: "deletion-mail-queue" }] },
    vars: { PLC_URL: TEST_PLC_URL },
    services: [{ binding: "INSTALLATION_DIRECTORY", service: STACK.accounts }, { binding: "INFERENCE_EXECUTION", service: STACK.inference },
      { binding: "RIPGIT", service: STACK.ripgit }, { binding: "INSTANCES", service: STACK.instances },
      { binding: "PDS", service: STACK.pds, entrypoint: "PdsPublisherEntrypoint", props: { authority: "kernel-publish" } }],
  };
  const accountsConfig: Unstable_RawConfig = {
    name: STACK.accounts, main: accounts.main, compatibility_date: accounts.compatibility_date, compatibility_flags: accounts.compatibility_flags,
    d1_databases: accounts.d1_databases?.map((binding) => ({ ...binding, migrations_dir: resolve(PUBLIC_ROOT, "workers/installations/migrations") })),
    vars: { ...accounts.vars, ENVIRONMENT: "test", GSV_ADMIN_ORIGIN: origin, GSV_BASE_DOMAIN: "example.invalid", GSV_OPERATOR_ACCESS_MODE: "operator",
      DELETION_DISCOVERY_NAMESPACES: Object.fromEntries(NAMESPACES.map(({ namespaceId, ownerId, kind }) => [namespaceId, { ownerId, kind }])),
      DELETION_RESOURCE_SCOPES: SCOPES },
    services: [
      { binding: "ACCOUNTS_GATEWAY_RECOVERY", service: STACK.gateway, entrypoint: "GatewayRecoveryEntrypoint", props: { authority: "installation-owner-recovery" } },
      { binding: "DELETION_OWNER_GATEWAY", service: STACK.evidence, entrypoint: "GatewayFaultRelay" },
      { binding: "DELETION_OWNER_INFERENCE", service: STACK.inference, entrypoint: "InferenceLifecycleEntrypoint", props: deletionProps },
      { binding: "DELETION_OWNER_MAIL", service: STACK.mail, entrypoint: "MailLifecycleEntrypoint", props: deletionProps },
      { binding: "DELETION_OWNER_INSTANCES", service: STACK.instances, entrypoint: "InstanceLifecycleEntrypoint", props: deletionProps },
      { binding: "DELETION_OWNER_PDS", service: STACK.pds, entrypoint: "PdsLifecycleEntrypoint", props: deletionProps },
      { binding: "DELETION_ADDITIONAL_EVIDENCE", service: STACK.evidence },
    ],
  };
  const inferenceConfig: Unstable_RawConfig = {
    name: STACK.inference, main: inference.main, compatibility_date: inference.compatibility_date,
    compatibility_flags: [...inference.compatibility_flags ?? [], "enable_abortsignal_rpc"], vars: inference.vars,
    durable_objects: inference.durable_objects, migrations: inference.migrations,
    services: [{ binding: "INSTALLATION_DIRECTORY", service: STACK.accounts }, { binding: "AI", service: STACK.dependencies }],
  };
  const mailConfig: Unstable_RawConfig = {
    name: STACK.mail, main: mail.main, compatibility_date: mail.compatibility_date, compatibility_flags: mail.compatibility_flags,
    vars: { ...mail.vars, MAIL_DOMAIN: "example.invalid", GSV_BASE_DOMAIN: "example.invalid" },
    durable_objects: mail.durable_objects, migrations: mail.migrations, send_email: mail.send_email,
    queues: { consumers: [{ queue: "deletion-mail-queue", max_batch_size: 10, max_batch_timeout: 1 }] },
    services: [{ binding: "ACCOUNTS", service: STACK.accounts }, { binding: "GATEWAY", service: STACK.gateway, entrypoint: "GatewayEntrypoint" },
      { binding: "INFERENCE", service: STACK.inference }],
  };
  const ripgitConfig: Unstable_RawConfig = {
    name: STACK.ripgit, main: resolve(PUBLIC_ROOT, "workers/ripgit/build/index.js"), compatibility_date: "2026-09-01",
    durable_objects: { bindings: [{ name: "REPOSITORY", class_name: "Repository" }] }, migrations: [{ tag: "v1", new_sqlite_classes: ["Repository"] }],
    kv_namespaces: [{ binding: "REGISTRY", id: "repository-registry" }],
  };
  const instancesConfig: Unstable_RawConfig = {
    name: STACK.instances, main: instances.main, compatibility_date: instances.compatibility_date,
    compatibility_flags: instances.compatibility_flags, vars: instances.vars,
    durable_objects: instances.durable_objects, migrations: instances.migrations,
    r2_buckets: [{ binding: "PROFILES", bucket_name: "browser-profiles" }],
    services: [{ binding: "INSTALLATION_DIRECTORY", service: STACK.accounts }],
  };
  const pdsConfig: Unstable_RawConfig = {
    name: STACK.pds, main: pds.main, compatibility_date: pds.compatibility_date, compatibility_flags: pds.compatibility_flags,
    durable_objects: pds.durable_objects, migrations: pds.migrations,
    r2_buckets: [{ binding: "BLOBS", bucket_name: "pds-blobs" }],
    // A synthetic rotation key; only the test directory ever sees what it signs.
    vars: { PDS_ORIGIN: "https://pds.example.invalid", PLC_URL: TEST_PLC_URL, PLC_ROTATION_KEY: "0123456789abcdef".repeat(4) },
    services: [{ binding: "INSTALLATION_DIRECTORY", service: STACK.accounts }],
  };
  return createTestHarness({ root: resolve(PUBLIC_ROOT, "workers/gateway"), workers: [
    { config: gatewayConfig }, { config: accountsConfig }, { config: inferenceConfig }, { config: mailConfig }, { config: ripgitConfig }, { config: instancesConfig },
    { config: pdsConfig },
    { config: { name: STACK.dependencies, main: dependencies.main, compatibility_date: dependencies.compatibility_date,
      compatibility_flags: [...dependencies.compatibility_flags ?? [], "enable_abortsignal_rpc"], durable_objects: dependencies.durable_objects,
      migrations: dependencies.migrations } },
    { config: { name: STACK.evidence, main: resolve(import.meta.dirname, "deletion-stack-evidence.ts"), compatibility_date: "2026-09-01",
      vars: { LOSE_ERASE_REPLY: 1 },
      durable_objects: { bindings: [{ name: "INFERENCE_EXECUTORS", class_name: "InferenceExecutor", script_name: STACK.inference },
        { name: "PDS_REPOS", class_name: "HostedRepo", script_name: STACK.pds }] },
      services: [{ binding: "GATEWAY_REAL", service: STACK.gateway, entrypoint: "GatewayLifecycleEntrypoint", props: deletionProps },
        { binding: "INFERENCE_SERVICE", service: STACK.inference }, { binding: "MAIL_SERVICE", service: STACK.mail }] } },
  ] });
}
