import { GSV_INFERENCE_FEATURE } from "@humansandmachines/gsv/protocol";
import { describe, expect, it } from "vitest";
import {
  AI_PROVIDER_OPTIONS,
  aiModelAfterProviderChange,
  aiProviderDisplayLabel,
  aiProviderOptionsForFeatures,
  aiProviderOptionsForValue,
  fixedAiProviderModel,
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
      fixedModel: "default",
    });
  });

  it("treats the GSV model as a fixed product implementation detail", () => {
    expect(fixedAiProviderModel("gsv")).toBe("default");
    expect(fixedAiProviderModel("openrouter")).toBeNull();
    expect(aiModelAfterProviderChange("openrouter", "deepseek/model", "gsv")).toBe("default");
    expect(aiModelAfterProviderChange("gsv", "default", "openrouter")).toBe("");
    expect(aiProviderDisplayLabel("gsv")).toBe("GSV included");
  });

  it("preserves the managed provider label for an existing GSV value", () => {
    expect(aiProviderOptionsForValue("gsv").at(-1)).toEqual({
      value: "gsv",
      label: "GSV included",
      fixedModel: "default",
    });
  });
});
