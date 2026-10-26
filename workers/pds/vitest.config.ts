import { randomBytes } from "node:crypto";
import { Secp256k1PrivateKeyExportable } from "@atcute/crypto";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.test.jsonc" },
    // Each run signs PLC operations with a fresh throwaway key, below a throwaway operator recovery key.
    miniflare: { bindings: {
      PLC_ROTATION_KEY: randomBytes(32).toString("hex"),
      PLC_RECOVERY_KEY: await (await Secp256k1PrivateKeyExportable.createKeypair()).exportPublicKey("did"),
    } },
  })],
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
