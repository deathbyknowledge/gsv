import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestHarness, type TestHarness } from "wrangler";

const GATEWAY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEPENDENCY_WORKER = "gsv-test-dependencies";

export function createGatewayTestHarness(): TestHarness {
  return createTestHarness({
    root: GATEWAY_ROOT,
    workers: [
      {
        configPath: "wrangler.jsonc",
        bindingOverrides: {
          AI: DEPENDENCY_WORKER,
          CHANNEL_DISCORD: DEPENDENCY_WORKER,
          CHANNEL_TELEGRAM: DEPENDENCY_WORKER,
          RIPGIT: DEPENDENCY_WORKER,
        },
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
