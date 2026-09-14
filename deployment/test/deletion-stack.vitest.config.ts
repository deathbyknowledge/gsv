import { defineConfig } from "vitest/config";

// Requires built web/ripgit assets and Mail dependencies; CI prepares them before this local gate.
// Cloudflare account admission, external providers, and backup expiry remain separate acceptance gates.
export default defineConfig({ test: { include: ["deployment/test/installation-deletion-stack.acceptance.ts", "deployment/test/installation-onboarding-stack.acceptance.ts"], environment: "node",
  fileParallelism: false, hookTimeout: 120_000, testTimeout: 120_000 } });
