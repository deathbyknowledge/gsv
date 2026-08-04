import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createTestHarness,
  type TestHarness,
  type Unstable_RawConfig,
  unstable_readConfig,
} from "wrangler";

const GATEWAY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ACCOUNT_ROOT = resolve(GATEWAY_ROOT, "../account-service");
const INFERENCE_ROOT = resolve(GATEWAY_ROOT, "../inference-service");
const DEPENDENCY_WORKER = "gsv-test-dependencies";
const ACCOUNT_WORKER = "gsv-accounts-integration";
const INFERENCE_WORKER = "gsv-inference-integration";
const DEPENDENCY_CONFIG_PATH = resolve(
  GATEWAY_ROOT,
  "test-integration/fixtures/wrangler.jsonc",
);

function integrationGatewayConfig(options: {
  name?: string;
  managed?: boolean;
  directoryService?: string;
  managedInferenceService?: string;
} = {}): Unstable_RawConfig {
  const config = unstable_readConfig(
    { config: resolve(GATEWAY_ROOT, "wrangler.jsonc") },
    { hideWarnings: true },
  );

  return {
    name: options.name ?? config.name,
    main: config.main,
    compatibility_date: config.compatibility_date,
    compatibility_flags: config.compatibility_flags,
    define: config.define,
    rules: config.rules,
    migrations: config.migrations,
    durable_objects: config.durable_objects,
    observability: config.observability,
    r2_buckets: config.r2_buckets,
    assets: config.assets,
    // CodeMode is an optional paid capability in production. Keep its loader
    // test-only while exercising that runtime boundary in integration tests.
    worker_loaders: [{ binding: "LOADER" }],
    ai: undefined,
    services: [
      { binding: "AI", service: DEPENDENCY_WORKER },
      { binding: "CHANNEL_DISCORD", service: DEPENDENCY_WORKER },
      { binding: "CHANNEL_TELEGRAM", service: DEPENDENCY_WORKER },
      { binding: "CHANNEL_WHATSAPP", service: DEPENDENCY_WORKER },
      { binding: "RIPGIT", service: DEPENDENCY_WORKER },
      ...(options.managed
        ? [{
            binding: "INSTALLATION_DIRECTORY",
            service: options.directoryService ?? DEPENDENCY_WORKER,
          }, ...(options.managedInferenceService
            ? [{
                binding: "MANAGED_INFERENCE",
                service: options.managedInferenceService,
              }]
            : [])]
        : []),
    ],
  };
}

function integrationInferenceConfig(accountService: string): Unstable_RawConfig {
  const config = unstable_readConfig(
    { config: resolve(INFERENCE_ROOT, "wrangler.jsonc") },
    { hideWarnings: true },
  );
  return {
    name: INFERENCE_WORKER,
    main: resolve(INFERENCE_ROOT, "src/index.ts"),
    // Keep integration workerd aligned with the Vitest pool release.
    compatibility_date: "2026-07-01",
    compatibility_flags: config.compatibility_flags,
    observability: config.observability,
    vars: {
      ...config.vars,
      ENVIRONMENT: "test",
      MANAGED_INFERENCE_PROVIDER: "synthetic",
      SYNTHETIC_DELAY_MS: "1",
      SYNTHETIC_FAIL_FIRST_ATTEMPT: "true",
    },
    durable_objects: config.durable_objects,
    migrations: config.migrations,
    services: [{
      binding: "ENTITLEMENTS",
      service: accountService,
      entrypoint: "EntitlementReaderEntrypoint",
    }],
  };
}

function integrationAccountConfig(gatewayService: string): Unstable_RawConfig {
  const config = unstable_readConfig(
    { config: resolve(ACCOUNT_ROOT, "wrangler.jsonc") },
    { hideWarnings: true },
  );
  return {
    name: ACCOUNT_WORKER,
    main: resolve(ACCOUNT_ROOT, "src/index.ts"),
    compatibility_date: config.compatibility_date,
    compatibility_flags: config.compatibility_flags,
    observability: config.observability,
    vars: {
      ...config.vars,
      ENVIRONMENT: "test",
    },
    d1_databases: config.d1_databases?.map((
      database: NonNullable<Unstable_RawConfig["d1_databases"]>[number],
    ) => ({
      ...database,
      migrations_dir: resolve(ACCOUNT_ROOT, "migrations"),
    })),
    services: [{
      binding: "GATEWAY",
      service: gatewayService,
      entrypoint: "GatewayEntrypoint",
    }],
  };
}

function integrationDependencyConfig(
  gatewayService: string,
): Unstable_RawConfig {
  const config = unstable_readConfig(
    { config: DEPENDENCY_CONFIG_PATH },
    { hideWarnings: true },
  );
  return {
    name: config.name,
    main: config.main,
    compatibility_date: config.compatibility_date,
    compatibility_flags: config.compatibility_flags,
    observability: config.observability,
    durable_objects: config.durable_objects,
    migrations: config.migrations,
    services: [{
      binding: "GATEWAY",
      service: gatewayService,
      entrypoint: "GatewayEntrypoint",
    }],
  };
}

export function createGatewayTestHarness(): TestHarness {
  return createTestHarness({
    root: GATEWAY_ROOT,
    workers: [
      {
        config: integrationGatewayConfig(),
      },
      {
        config: integrationDependencyConfig("gsv"),
      },
    ],
  });
}

export function createManagedGatewayTestHarness(): TestHarness {
  return createTestHarness({
    root: GATEWAY_ROOT,
    workers: [
      {
        config: integrationGatewayConfig(),
      },
      {
        config: integrationGatewayConfig({ name: "gsv-managed", managed: true }),
      },
      {
        config: integrationDependencyConfig("gsv-managed"),
      },
    ],
  });
}

export function createManagedAccountTestHarness(): TestHarness {
  return createTestHarness({
    root: GATEWAY_ROOT,
    workers: [
      {
        config: integrationGatewayConfig({
          name: "gsv-managed-account",
          managed: true,
          directoryService: ACCOUNT_WORKER,
          managedInferenceService: INFERENCE_WORKER,
        }),
      },
      {
        config: integrationDependencyConfig("gsv-managed-account"),
      },
      {
        config: integrationAccountConfig("gsv-managed-account"),
      },
      {
        config: integrationInferenceConfig(ACCOUNT_WORKER),
      },
    ],
  });
}

export function webSocketUrl(baseUrl: URL): string {
  const url = new URL("/ws", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
