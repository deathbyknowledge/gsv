import { describe, expect, it } from "vitest";
import { baseAiModelStack, GSV_INCLUDED_MODEL_ID } from "./base-model-stack";
import { DEFAULT_TEXT_GENERATION_MAX_TOKENS } from "./default-models";

describe("operator base model stack", () => {
  it("delegates the default provider to the operator's inference service", () => {
    expect(baseAiModelStack()).toEqual([{
      id: GSV_INCLUDED_MODEL_ID,
      name: "Ship Included",
      provider: "gsv",
      model: "default",
      maxTokens: DEFAULT_TEXT_GENERATION_MAX_TOKENS,
    }]);
  });
});
