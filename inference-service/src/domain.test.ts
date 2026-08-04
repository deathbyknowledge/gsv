import { describe, expect, it } from "vitest";
import { MANAGED_INFERENCE_PRODUCT_MODEL } from "@humansandmachines/gsv/protocol";
import { parseCurrentEntitlement, parseInferenceRequest } from "./domain";

describe("managed inference boundary", () => {
  it("rejects media instead of silently replacing it", () => {
    expect(() => parseInferenceRequest({
      ...request(),
      messages: [{
        role: "user",
        content: [{ type: "image", data: "AA==", mimeType: "image/png" }],
      }],
    })).toThrow("does not accept image or audio");
  });

  it("allows active and grace-period entitlements but rejects restriction", () => {
    const now = Date.now();
    const entitlement = {
      installationId: "inst_test",
      state: "past_due" as const,
      planKey: "test",
      inferenceBudgetMicrounits: 5_000_000,
      inferencePeriodStartsAt: now - 1_000,
      inferencePeriodEndsAt: now + 1_000,
      storageLimitBytes: 1,
      effectiveAt: now - 1_000,
      version: 1,
    };
    expect(parseCurrentEntitlement(entitlement, "inst_test", now)).toEqual(entitlement);
    expect(() => parseCurrentEntitlement({
      ...entitlement,
      state: "restricted",
      version: 2,
    }, "inst_test", now)).toThrow("restricted");
  });
});

function request() {
  return {
    version: 1 as const,
    installationId: "inst_test",
    logicalRequestId: "request_test",
    actor: { localUid: 1000 },
    model: MANAGED_INFERENCE_PRODUCT_MODEL,
    capability: "text" as const,
    messages: [{ role: "user" as const, content: "hello" }],
    maxOutputTokens: 128,
    timeoutMs: 1_000,
  };
}
