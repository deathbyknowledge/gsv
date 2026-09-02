import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";
import { fileURLToPath } from "node:url";

const env = { ...process.env, ...loadEnv("test", process.cwd(), "") };
// Workerd does not synthesize named exports from partial-json's CJS build
// when pi-ai imports it through the Vitest Workers runtime.
const partialJsonShimPath = fileURLToPath(new URL("./test-support/partial-json.ts", import.meta.url));
// pi-ai's ambient key discovery dynamically imports Node filesystem modules,
// which crashes the Vitest Workers module loader. GSV supplies provider keys
// explicitly, so tests replace only that unused discovery path.
const piAiEnvApiKeysShimPath = fileURLToPath(new URL("./test-support/pi-ai-env-api-keys.ts", import.meta.url));

export default defineConfig({
  plugins: [
    {
      name: "pi-ai-env-api-keys-shim",
      enforce: "pre",
      resolveId(source, importer) {
        if (importer?.includes("/@earendil-works/pi-ai/dist/") && source.endsWith("/env-api-keys.js")) {
          return piAiEnvApiKeysShimPath;
        }
      },
    },
    cloudflareTest({
      wrangler: {
        // Use test config without service bindings (channels, AI)
        // to avoid needing external workers during unit tests
        configPath: "./wrangler.test.jsonc",
      },
    }),
  ],
  define: {
    __GSV_RELEASE__: JSON.stringify("dev"),
    __PRINT_FULL_PROMPT__: JSON.stringify(env.PRINT_FULL_PROMPT === "1"),
  },
  resolve: {
    alias: {
      "partial-json": partialJsonShimPath,
    },
  },
  test: {
    // Integration tests own a standalone Wrangler harness process.
    exclude: [
      "**/alchemy/**",
      "**/node_modules/**",
      "**/test-integration/**",
      "src/process/do.*.test.ts",
    ],
    deps: {
      optimizer: {
        ssr: {
          include: [
            "ajv",
            "turndown",
            "@earendil-works/pi-ai",
            "partial-json",
          ],
          esbuildOptions: {
            external: ["node:sqlite"],
          },
        },
      },
    },
  },
});
