import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createTestHarness,
  type TestHarness,
  type Unstable_RawConfig,
  unstable_readConfig,
} from "wrangler";

const GATEWAY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEPENDENCY_WORKER = "gsv-test-dependencies";
const ACCOUNTS_WORKER = "gsv-accounts-test";
const INFERENCE_WORKER = "gsv-inference-test";
const EMAIL_WORKER = "gsv-managed-email-test";
const DEPENDENCY_CONFIG_PATH = resolve(
  GATEWAY_ROOT,
  "test-integration/fixtures/wrangler.jsonc",
);
const EMAIL_CONFIG_PATH = resolve(
  GATEWAY_ROOT,
  "../adapters/email/wrangler.test.jsonc",
);

function integrationGatewayConfig(options: {
  name?: string;
  managed?: boolean;
  managedServices?: {
    accounts: string;
    inference: string;
  };
  managedMailQueue?: string;
} = {}): Unstable_RawConfig {
  const config = unstable_readConfig(
    { config: resolve(GATEWAY_ROOT, "wrangler.jsonc") },
    { hideWarnings: true },
  );
  const lifecycleConfig = options.managed
    ? unstable_readConfig(
        { config: resolve(GATEWAY_ROOT, "wrangler.managed.dev.jsonc") },
        { hideWarnings: true },
      )
    : config;

  return {
    name: options.name ?? config.name,
    main: config.main,
    compatibility_date: config.compatibility_date,
    compatibility_flags: config.compatibility_flags,
    define: config.define,
    rules: config.rules,
    migrations: lifecycleConfig.migrations,
    durable_objects: {
      bindings: [
        ...(lifecycleConfig.durable_objects?.bindings ?? []).filter(
          (binding: { name: string }) =>
            binding.name !== "MANAGED_INFERENCE_INSTALLATIONS",
        ),
        ...(options.managedServices
          ? [{
              name: "MANAGED_INFERENCE_INSTALLATIONS",
              class_name: "InferenceInstallation",
              script_name: options.managedServices.inference,
            }]
          : []),
      ],
    },
    observability: config.observability,
    r2_buckets: config.r2_buckets,
    queues: options.managedMailQueue
      ? {
          producers: [{
            binding: "MANAGED_MAIL_OUTBOUND",
            queue: options.managedMailQueue,
          }],
        }
      : undefined,
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
        ? [
            {
              binding: "INSTALLATION_DIRECTORY",
              service: options.managedServices?.accounts ?? DEPENDENCY_WORKER,
            },
            ...(options.managedServices
              ? []
              : [{
                  binding: "MANAGED_INFERENCE",
                  service: DEPENDENCY_WORKER,
                  entrypoint: "ManagedInferenceFixture",
                }]),
          ]
        : []),
    ],
  };
}

function integrationEmailConfig(
  gatewayService: string,
  queue: string,
): Unstable_RawConfig {
  const config = unstable_readConfig(
    { config: EMAIL_CONFIG_PATH },
    { hideWarnings: true },
  );
  return {
    name: EMAIL_WORKER,
    main: resolve(GATEWAY_ROOT, "../adapters/email/src/index.ts"),
    compatibility_date: config.compatibility_date,
    compatibility_flags: config.compatibility_flags,
    observability: config.observability,
    vars: config.vars,
    durable_objects: config.durable_objects,
    migrations: config.migrations,
    send_email: config.send_email,
    services: [
      { binding: "ACCOUNTS", service: ACCOUNTS_WORKER },
      {
        binding: "GATEWAY",
        service: gatewayService,
        entrypoint: "GatewayEntrypoint",
      },
      {
        binding: "INFERENCE",
        service: INFERENCE_WORKER,
        entrypoint: "InferenceService",
      },
    ],
    queues: {
      consumers: [{
        queue,
        max_batch_size: 10,
        max_batch_timeout: 1,
        max_retries: 5,
      }],
    },
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
    compatibility_flags: [
      ...(config.compatibility_flags ?? []),
      "enable_abortsignal_rpc",
    ],
    observability: config.observability,
    durable_objects: config.durable_objects,
    migrations: config.migrations,
    services: [
      {
        binding: "TELEGRAM_GATEWAY",
        service: gatewayService,
        entrypoint: "AdapterGatewayEntrypoint",
        props: {
          id: "telegram",
          calls: ["adapter.inbound", "adapter.state.update"],
        },
      },
      {
        binding: "DISCORD_GATEWAY",
        service: gatewayService,
        entrypoint: "AdapterGatewayEntrypoint",
        props: {
          id: "discord",
          calls: ["adapter.inbound", "adapter.state.update"],
        },
      },
    ],
  };
}

function integrationManagedInferenceConfig(
  configPath: string,
): Unstable_RawConfig {
  const config = unstable_readConfig(
    { config: configPath },
    { hideWarnings: true },
  );
  return {
    name: config.name,
    main: config.main,
    compatibility_date: config.compatibility_date,
    compatibility_flags: [
      ...(config.compatibility_flags ?? []),
      "enable_abortsignal_rpc",
    ],
    rules: config.rules,
    observability: config.observability,
    vars: config.vars,
    durable_objects: config.durable_objects,
    migrations: config.migrations,
    services: [
      { binding: "ACCOUNTS", service: ACCOUNTS_WORKER },
      { binding: "AI", service: DEPENDENCY_WORKER },
    ],
  };
}

function managedInferenceProbeConfig(): Unstable_RawConfig {
  const config = unstable_readConfig(
    { config: DEPENDENCY_CONFIG_PATH },
    { hideWarnings: true },
  );
  return {
    name: "gsv-managed-inference-probe",
    main: resolve(
      GATEWAY_ROOT,
      "test-integration/fixtures/managed-inference-probe.ts",
    ),
    compatibility_date: config.compatibility_date,
    compatibility_flags: config.compatibility_flags,
    observability: config.observability,
    services: [{
      binding: "MANAGED_INFERENCE",
      service: DEPENDENCY_WORKER,
      entrypoint: "ManagedInferenceFixture",
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
      {
        config: managedInferenceProbeConfig(),
      },
    ],
  });
}

export function createManagedInferenceServiceStackTestHarness(
  serviceConfigs: { accounts: string; inference: string },
): TestHarness {
  const gatewayService = "gsv-managed-inference-stack";
  return createTestHarness({
    root: GATEWAY_ROOT,
    workers: [
      {
        config: integrationGatewayConfig({
          name: gatewayService,
          managed: true,
          managedServices: {
            accounts: ACCOUNTS_WORKER,
            inference: INFERENCE_WORKER,
          },
        }),
      },
      {
        config: integrationDependencyConfig(gatewayService),
      },
      {
        configPath: serviceConfigs.accounts,
        vars: {
          ENVIRONMENT: "development",
          GSV_ACCOUNT_ORIGIN: "http://localhost",
          GSV_BASE_DOMAIN: "gsv.space",
        },
      },
      {
        config: integrationManagedInferenceConfig(serviceConfigs.inference),
      },
    ],
  });
}

export function createManagedMailServiceStackTestHarness(
  serviceConfigs: { accounts: string; inference: string },
): TestHarness {
  const gatewayService = "gsv-managed-mail-stack";
  const queue = "gsv-managed-mail-outbound-stack";
  return createTestHarness({
    root: GATEWAY_ROOT,
    workers: [
      {
        config: integrationGatewayConfig({
          name: gatewayService,
          managed: true,
          managedServices: {
            accounts: ACCOUNTS_WORKER,
            inference: INFERENCE_WORKER,
          },
          managedMailQueue: queue,
        }),
      },
      {
        config: integrationDependencyConfig(gatewayService),
      },
      {
        configPath: serviceConfigs.accounts,
        vars: {
          ENVIRONMENT: "development",
          GSV_ACCOUNT_ORIGIN: "http://localhost",
          GSV_BASE_DOMAIN: "gsv.space",
        },
      },
      {
        config: integrationManagedInferenceConfig(serviceConfigs.inference),
      },
      {
        config: integrationEmailConfig(gatewayService, queue),
      },
    ],
  });
}

export function webSocketUrl(baseUrl: URL): string {
  const url = new URL("/ws", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
