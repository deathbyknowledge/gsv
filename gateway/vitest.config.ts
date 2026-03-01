import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  define: {
    __PRINT_FULL_PROMPT__: JSON.stringify(process.env.PRINT_FULL_PROMPT === "1"),
  },
  test: {
    // Exclude e2e tests (they use bun:test, not vitest)
    exclude: ["**/alchemy/**", "**/node_modules/**"],
    deps: {
      optimizer: {
        ssr: {
          include: [
            // vitest can't seem to properly import
            // `require('./path/to/anything.json')` files,
            // which ajv uses (by way of @modelcontextprotocol/sdk)
            // the workaround is to add the package to the include list
            "ajv"
          ]
        }
      }
    },
    poolOptions: {
      workers: {
        isolatedStorage: false,
        singleWorker: true,
        wrangler: {
          // Use test config without service bindings (channels, AI)
          // to avoid needing external workers during unit tests
          configPath: "./wrangler.test.jsonc"
        }
      }
    }
  }
});
