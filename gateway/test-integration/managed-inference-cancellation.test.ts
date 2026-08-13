import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createTestHarness,
  type TestHarness,
  type Unstable_RawConfig,
} from "wrangler";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

const GATEWAY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INFERENCE_WORKER = "gsv-inference-test";
const POLICY_WORKER = "gsv-managed-inference-policy";
const PROBE_WORKER = "gsv-managed-inference-cancellation-probe";

let harness: TestHarness;

beforeAll(async () => {
  harness = createTestHarness({
    root: GATEWAY_ROOT,
    workers: [
      {
        config: probeConfig(),
      },
      {
        configPath: resolve(GATEWAY_ROOT, "../inference/wrangler.test.jsonc"),
        bindingOverrides: { ACCOUNTS: POLICY_WORKER },
      },
      {
        config: policyConfig(),
      },
    ],
  });
  await harness.listen();
});

afterAll(async () => {
  await harness.close();
});

it("honors an immediate cross-worker abort before provider dispatch", async () => {
  const providerFetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("provider fetch must not start"),
  );
  const response = await harness.getWorker(PROBE_WORKER).fetch(
    "http://gsv-managed-inference-cancellation-probe/abort-first?installationId=installation_immediate_cancellation&logicalRequestId=request_immediate_cancellation",
  );

  expect(response.status).toBe(204);
  expect(providerFetch).not.toHaveBeenCalled();
});

function probeConfig(): Unstable_RawConfig {
  return {
    name: PROBE_WORKER,
    main: resolve(
      GATEWAY_ROOT,
      "test-integration/fixtures/managed-inference-probe.ts",
    ),
    compatibility_date: "2026-07-29",
    compatibility_flags: ["nodejs_compat"],
    services: [{
      binding: "MANAGED_INFERENCE",
      service: INFERENCE_WORKER,
      entrypoint: "InferenceService",
    }],
  };
}

function policyConfig(): Unstable_RawConfig {
  return {
    name: POLICY_WORKER,
    main: resolve(
      GATEWAY_ROOT,
      "test-integration/fixtures/managed-inference-policy.ts",
    ),
    compatibility_date: "2026-07-29",
    compatibility_flags: ["nodejs_compat"],
  };
}
