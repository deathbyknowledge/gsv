import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const configPath = fileURLToPath(new URL("./worker/wrangler.jsonc", import.meta.url));

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath } })],
  test: {
    include: ["tools/protocol/capnp-v4/worker/**/*.test.ts"],
  },
});
