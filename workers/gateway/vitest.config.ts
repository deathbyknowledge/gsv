import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";

const env = { ...process.env, ...loadEnv("test", process.cwd(), "") };
export default defineConfig({
  plugins: [
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
          ],
          esbuildOptions: {
            external: ["node:sqlite"],
          },
        },
      },
    },
  },
});
