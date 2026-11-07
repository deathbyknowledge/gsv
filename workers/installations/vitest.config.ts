import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [cloudflareTest(async () => ({
          wrangler: { configPath: path.join(root, "wrangler.jsonc") },
          miniflare: { bindings: { TEST_MIGRATIONS: await readD1Migrations(path.join(root, "migrations")) } },
        }))],
        test: { name: "worker", include: ["src/**/*.test.ts"], setupFiles: ["./test/apply-migrations.ts"] },
      },
      // Checks of the source itself, which run in Node so they can read and parse it.
      { test: { name: "source", include: ["test/**/*.test.ts"], environment: "node" } },
    ],
  },
});
