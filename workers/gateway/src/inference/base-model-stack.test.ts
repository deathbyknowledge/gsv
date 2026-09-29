import { describe, expect, it } from "vitest";
import { baseAiModelStack, GSV_INCLUDED_MODEL_ID } from "./base-model-stack";
import { gsvInferenceFeaturesFromEnv } from "./features";
import { GSV_INFERENCE_FEATURE } from "@humansandmachines/gsv/services/inference";
import { DEFAULT_TEXT_GENERATION_MAX_TOKENS } from "./default-models";

describe("operator base model stack", () => {
  it("delegates the default provider to the operator's inference service", () => {
    expect(baseAiModelStack()).toEqual([{
      id: GSV_INCLUDED_MODEL_ID,
      name: "GSV Included",
      provider: "gsv",
      model: "default",
      maxTokens: DEFAULT_TEXT_GENERATION_MAX_TOKENS,
    }]);
  });

  it("advertises execution independently of optional commercial services", () => {
    // SAFETY: Feature discovery reads only the presence of the execution binding.
    expect(gsvInferenceFeaturesFromEnv({ INFERENCE_EXECUTION: {} } as never)).toEqual([GSV_INFERENCE_FEATURE]);
    // SAFETY: Feature discovery must ignore commercial-only bindings when execution is absent.
    expect(gsvInferenceFeaturesFromEnv({ MANAGED_INFERENCE: {}, MANAGED_INFERENCE_INSTALLATIONS: {} } as never)).toEqual([]);
    // SAFETY: A deliberately incomplete deployment has no feature to advertise.
    expect(gsvInferenceFeaturesFromEnv({} as never)).toEqual([]);
  });
});
