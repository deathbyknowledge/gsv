import { describe, expect, it } from "vitest";
import { DEEPSEEK_V4_FLASH_0731_PRICE } from "./price-book";
import {
  isManagedInferenceReleaseApproved,
  MANAGED_INFERENCE_RELEASE_GATE,
} from "./release-gate";
import { resolveManagedProvider } from "./providers/router";

describe("managed inference release gate", () => {
  it("cannot be enabled by a production environment variable and credential alone", () => {
    expect(() => resolveManagedProvider({
      ENVIRONMENT: "production",
      MANAGED_INFERENCE_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "test-only-key",
    })).toThrow("has not passed release gates");
  });

  it("starts blocked without mutable evidence placeholders", () => {
    expect(MANAGED_INFERENCE_RELEASE_GATE).toMatchObject({
      status: "blocked",
      evidenceReports: [],
      approvals: {
        evaluation: false,
        privacyAndDataProcessing: false,
        security: false,
        capacityAndReliability: false,
        brandAndAcceptableUse: false,
      },
    });
    expect(isManagedInferenceReleaseApproved(
      DEEPSEEK_V4_FLASH_0731_PRICE.provider,
      DEEPSEEK_V4_FLASH_0731_PRICE.modelRevision,
    )).toBe(false);
  });
});
