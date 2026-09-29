import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    hookTimeout: 120000,
    include: ["tests/**/*.spec.mjs"],
    testTimeout: 120000,
  },
});
