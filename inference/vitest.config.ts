import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const partialJsonShimPath = fileURLToPath(
  new URL("../gateway/test-support/partial-json.ts", import.meta.url),
);
const piAiEnvApiKeysShimPath = fileURLToPath(
  new URL("../gateway/test-support/pi-ai-env-api-keys.ts", import.meta.url),
);

export default defineConfig({
  plugins: [
    {
      name: "pi-ai-env-api-keys-shim",
      enforce: "pre",
      resolveId(source, importer) {
        if (
          importer?.includes("/@earendil-works/pi-ai/dist/")
          && source.endsWith("/env-api-keys.js")
        ) {
          return piAiEnvApiKeysShimPath;
        }
      },
    },
    cloudflareTest({
      wrangler: { configPath: "./wrangler.test.jsonc" },
      miniflare: {
        bindings: {
          OPENROUTER_API_KEY: "test-key",
        },
        workers: [{
          name: "gsv-accounts-test-sink",
          modules: true,
          script: `
            import { WorkerEntrypoint } from "cloudflare:workers";
            export default class AccountsUsageSink extends WorkerEntrypoint {
              async recordManagedInferenceUsage(events) {
                if (!Array.isArray(events) || events.length === 0) {
                  throw new Error("missing usage events");
                }
                for (const event of events) {
                  if (
                    event.version !== 1
                    || typeof event.installationId !== "string"
                    || typeof event.logicalRequestId !== "string"
                    || !Number.isSafeInteger(event.costNanoUsd)
                    || event.totalTokens !== event.inputTokens
                      + event.outputTokens
                      + event.cacheReadTokens
                      + event.cacheWriteTokens
                  ) {
                    throw new Error("invalid usage event");
                  }
                }
              }
            }
          `,
        }],
        serviceBindings: {
          ACCOUNTS: "gsv-accounts-test-sink",
        },
      },
    }),
  ],
  resolve: {
    alias: {
      "partial-json": partialJsonShimPath,
    },
  },
  test: {
    deps: {
      optimizer: {
        ssr: {
          include: ["@earendil-works/pi-ai", "partial-json"],
        },
      },
    },
  },
});
