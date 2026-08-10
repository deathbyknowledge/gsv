import { GSV_INFERENCE_FEATURE } from "@humansandmachines/gsv/protocol";
import { describe, expect, it } from "vitest";
import {
  AI_PROVIDER_OPTIONS,
  aiProviderOptionsForFeatures,
} from "./aiProviders";

describe("AI provider options", () => {
  it("keeps GSV inference out of standalone provider options", () => {
    expect(AI_PROVIDER_OPTIONS.some((option) => option.value === "gsv")).toBe(false);
    expect(aiProviderOptionsForFeatures(undefined).some((option) => option.value === "gsv")).toBe(false);
  });

  it("adds GSV inference when the gateway advertises it", () => {
    expect(aiProviderOptionsForFeatures([GSV_INFERENCE_FEATURE])[0]).toEqual({
      value: "gsv",
      label: "GSV included",
      defaultModel: "default",
    });
  });
});
