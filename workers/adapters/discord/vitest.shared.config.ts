import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { discordGatewayFixture, discordProviderFixture } from "./test/fixtures.ts";
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.shared.test.jsonc" }, miniflare: { workers: [
    { name: "shared-discord-api-test", modules: true, script: discordProviderFixture, durableObjects: { PROVIDER: { className: "Provider", useSQLite: true } } },
    { name: "shared-discord-gateway-test", modules: true, script: discordGatewayFixture },
  ] } })],
  test: { include: ["test/shared-flow.test.ts", "test/retirement.test.ts"] },
});
