import { describe, expect, it } from "vitest";
import { baseAiModelStack, GSV_INCLUDED_MODEL_ID } from "./base-model-stack";
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
});
