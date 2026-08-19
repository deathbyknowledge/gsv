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
              async getManagedInferencePolicy(installationId) {
                return {
                  version: 1,
                  installationId,
                  enabled: !installationId.endsWith("_policy_disabled"),
                  monthlyLimitNanoUsd: installationId.endsWith("_policy_limited")
                    ? 1_000
                    : Number.MAX_SAFE_INTEGER,
                };
              }

              async recordManagedInferenceUsage(events) {
                if (!Array.isArray(events) || events.length === 0) {
                  throw new Error("missing usage events");
                }
                for (const event of events) {
                  if (
                    event.version !== 1
                    || typeof event.installationId !== "string"
                    || typeof event.logicalRequestId !== "string"
                    || !["agent", "mail-intake"].includes(event.purpose)
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
        }, {
          name: "gsv-openrouter-test",
          modules: true,
          script: `
            export default {
              async fetch(request) {
                const payload = await request.json();
                const mail = payload.messages?.some((message) =>
                  message.role === "system"
                    && message.content?.includes("untrusted data")
                );
                const content = mail
                  ? JSON.stringify({
                      summary: "Mike asked whether tomorrow's meeting is still scheduled.",
                      category: "work",
                      requiresAttention: true,
                      confidence: 0.9,
                    })
                  : "pong";
                const id = mail
                  ? "generation_service_mail_rpc"
                  : "generation_service_rpc";
                const body = "data: " + JSON.stringify({
                  id,
                  model: "deepseek/deepseek-v4-flash-0731",
                  choices: [{ index: 0, delta: { content } }],
                }) + "\\n\\n" + "data: " + JSON.stringify({
                  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                  usage: {
                    prompt_tokens: 2,
                    completion_tokens: 1,
                    total_tokens: 3,
                  },
                }) + "\\n\\ndata: [DONE]\\n\\n";
                return new Response(body, {
                  headers: { "content-type": "text/event-stream" },
                });
              },
            };
          `,
        }],
        outboundService: "gsv-openrouter-test",
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
