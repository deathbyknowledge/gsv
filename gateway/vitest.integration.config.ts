import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test-integration/**/*.test.ts"],
    environment: "node",
    fileParallelism: false,
    hookTimeout: 120_000,
    testTimeout: 120_000,
  },
});
