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

function integrationGatewayConfig(options: {
  name?: string;
  managed?: boolean;
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
        ? [{ binding: "INSTALLATION_DIRECTORY", service: DEPENDENCY_WORKER }]
        : []),
    ],
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
        configPath: "test-integration/fixtures/wrangler.jsonc",
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
        configPath: "test-integration/fixtures/wrangler.jsonc",
      },
    ],
  });
}

export function webSocketUrl(baseUrl: URL): string {
  const url = new URL("/ws", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
