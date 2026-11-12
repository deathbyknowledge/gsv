import { createHash } from "node:crypto";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/** The setup code the flow tests redeem; the deployment holds only its hash. */
export const TEST_SETUP_CODE = "test-setup-code-0123456789abcdef";
const setup = `${Date.now() + 24 * 60 * 60 * 1000}.${createHash("sha256").update(TEST_SETUP_CODE).digest("hex")}`;

// The S3 contract suite runs when an S3-compatible server is given, as CI does with versitygw.
const s3 = process.env.GSV_TEST_S3_ENDPOINT ? {
  S3_ENDPOINT: process.env.GSV_TEST_S3_ENDPOINT,
  S3_BUCKET: process.env.GSV_TEST_S3_BUCKET ?? "gsv-test",
  S3_REGION: "us-east-1",
  S3_ACCESS_KEY_ID: process.env.GSV_TEST_S3_ACCESS_KEY_ID ?? "",
  S3_SECRET_ACCESS_KEY: process.env.GSV_TEST_S3_SECRET_ACCESS_KEY ?? "",
} : {};

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.test.jsonc" },
    miniflare: { bindings: { GSV_SETUP: setup, GSV_TEST_SETUP_CODE: TEST_SETUP_CODE, ...s3 } },
  })],
  test: { include: ["test/**/*.test.ts"] },
});
