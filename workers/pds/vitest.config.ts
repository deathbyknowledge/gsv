import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.test.jsonc" } })],
  test: {
    include: ["test/**/*.test.ts"],
    // Bundle @atproto's CommonJS packages as Wrangler does; the pool cannot load their ESM dependencies.
    // Node builtins stay external for nodejs_compat to provide, as in a deployed Worker.
    deps: {
      optimizer: {
        ssr: {
          enabled: true,
          include: ["@atproto/crypto", "@atproto/lex-data", "@atproto/lex-json", "@atproto/repo"],
          rolldownOptions: { external: [/^node:/] },
        },
      },
    },
  },
});
