import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
import { loadEnv } from "vite";

const env = { ...process.env, ...loadEnv("test", process.cwd(), "") };

export default defineWorkersConfig({
  define: {
    __PRINT_FULL_PROMPT__: JSON.stringify(env.PRINT_FULL_PROMPT === "1"),
    __GSV_TEST_OPENAI_KEY__: JSON.stringify(env.GSV_TEST_OPENAI_KEY ?? ""),
  },
  test: {
    // Exclude e2e tests (they use bun:test, not vitest)
    exclude: ["**/alchemy/**", "**/node_modules/**"],
    deps: {
      optimizer: {
        ssr: {
          include: [
            "ajv",
            "turndown",
            "@mariozechner/pi-ai",
          ],
          esbuildOptions: {
            external: ["node:sqlite"],
          },
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
