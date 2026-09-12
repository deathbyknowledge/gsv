import { describe, expect, it } from "vitest";
import { baseAiModelStack, GSV_INCLUDED_MODEL_ID } from "./base-model-stack";
import { gsvInferenceFeaturesFromEnv } from "./features";
import { GSV_INFERENCE_FEATURE } from "@humansandmachines/gsv/services/inference";
import {
  DEFAULT_TEXT_GENERATION_MAX_TOKENS,
  DEFAULT_WORKERS_AI_FALLBACK_MODEL,
  DEFAULT_WORKERS_AI_MODEL,
} from "./default-models";

describe("baseAiModelStack", () => {
  it("supplies the Workers AI pair to self-hosted deployments", () => {
    // SAFETY: the base stack only inspects the managed inference bindings.
    const stack = baseAiModelStack({} as never);

    expect(stack.map((entry) => [entry.provider, entry.model])).toEqual([
      ["workers-ai", DEFAULT_WORKERS_AI_MODEL],
      ["workers-ai", DEFAULT_WORKERS_AI_FALLBACK_MODEL],
    ]);
    expect(stack.every((entry) => entry.maxTokens === DEFAULT_TEXT_GENERATION_MAX_TOKENS)).toBe(true);
  });

  it("supplies GSV Included to managed deployments", () => {
    // SAFETY: the base stack only inspects the managed inference bindings.
    const stack = baseAiModelStack({ MANAGED_INFERENCE: {} } as never);

    expect(stack).toEqual([
      expect.objectContaining({ id: GSV_INCLUDED_MODEL_ID, provider: "gsv", model: "default" }),
    ]);
  });

  it("preserves standalone model identities and fallbacks after execution moves to its own Worker", () => {
    // SAFETY: model selection inspects only the presence of trusted deployment bindings.
    const standalone = { INFERENCE_EXECUTION: {} } as never;
    expect(baseAiModelStack(standalone).map((entry) => [entry.id, entry.provider, entry.model])).toEqual([
      ["workers-ai-glm-5-3-flash", "workers-ai", DEFAULT_WORKERS_AI_MODEL],
      ["workers-ai-kimi-k2-6", "workers-ai", DEFAULT_WORKERS_AI_FALLBACK_MODEL],
    ]);
    expect(gsvInferenceFeaturesFromEnv(standalone)).toEqual([]);
  });

  it("keeps the operator default and feature available with the public directory and executor", () => {
    // SAFETY: model selection inspects only the presence of trusted deployment bindings.
    const multiSpace = { INSTALLATION_DIRECTORY: {}, INFERENCE_EXECUTION: {} } as never;
    expect(baseAiModelStack(multiSpace)).toEqual([
      expect.objectContaining({ id: GSV_INCLUDED_MODEL_ID, provider: "gsv", model: "default" }),
    ]);
    expect(gsvInferenceFeaturesFromEnv(multiSpace)).toEqual([GSV_INFERENCE_FEATURE]);
  });
});
