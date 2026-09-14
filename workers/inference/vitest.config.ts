import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Workerd does not synthesize named exports from partial-json's CJS build
// when pi-ai imports it through the Vitest Workers runtime.
const partialJson = fileURLToPath(new URL("./test-support/partial-json.ts", import.meta.url));
// pi-ai's ambient key discovery dynamically imports Node filesystem modules,
// which crashes the Vitest Workers module loader. GSV supplies provider keys
// explicitly, so tests replace only that unused discovery path.
const envApiKeys = fileURLToPath(new URL("./test-support/pi-ai-env-api-keys.ts", import.meta.url));

export default defineConfig({
  plugins: [{
    name: "pi-ai-explicit-credentials",
    enforce: "pre",
    resolveId(source, importer) {
      if (importer?.includes("/@earendil-works/pi-ai/dist/") && source.endsWith("/env-api-keys.js")) return envApiKeys;
    },
  }, cloudflareTest({
    wrangler: { configPath: "./wrangler.test.jsonc" },
    miniflare: {
      workers: [{
        name: "inference-test-directory",
        modules: true,
        script: `
          import { WorkerEntrypoint } from "cloudflare:workers";
          const states = new Map();
          export default class Directory extends WorkerEntrypoint {
            async setState(id, state) { states.set(id, state); }
            async resolveInstallation(id) {
              if (id.endsWith("_missing")) return { found: false };
              if (states.get(id) === "stuck") return new Promise((resolve) => setTimeout(() => resolve({ found: false }), 1000));
              return { found: true, installationId: id, state: states.get(id) ?? "active", handle: id, canonicalOrigin: "https://example.invalid" };
            }
          }
        `,
      }, {
        name: "inference-test-ai",
        modules: true,
        script: `export default function binding() {
          return {
            aiGatewayLogId: null,
            async models() { return [{ id: "@cf/test/new-model", properties: [{ property_id: "context_window", value: "12345" }] }]; },
            fetch(input, init) { return fetch(input, init); },
            async run(model, input) {
              if (model.includes("whisper")) return { text: "transcribed", language: "en" };
              if (model.includes("moondream")) return { caption: "An image" };
              return new Uint8Array([1, 2, 3]);
            }
          };
        }`,
      }],
      serviceBindings: { INSTALLATION_DIRECTORY: "inference-test-directory" },
      wrappedBindings: { AI: "inference-test-ai" },
    },
  })],
  resolve: { alias: { "partial-json": partialJson, "@humansandmachines/gsv/protocol": fileURLToPath(new URL("../../packages/gsv/src/protocol/index.ts", import.meta.url)) } },
  test: { deps: { optimizer: { ssr: { include: ["@earendil-works/pi-ai", "partial-json"] } } } },
});
