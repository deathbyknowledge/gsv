import { describe, expect, it } from "vitest";
import {
  resolveModelContextWindowFromRegistry,
  resolveModelMetadata,
  resolveModelThinkingLevel,
  resolvePiAiModel,
} from "../../src/text/model-registry";

describe("model registry metadata", () => {
  it.each(["gpt-6-astra", "gpt-5.6-sol"])("resolves %s from the upstream Codex catalog", (modelName) => {
    const model = resolvePiAiModel("openai-codex", modelName);
    expect(model).toMatchObject({ id: modelName, provider: "openai-codex", api: "openai-codex-responses" });
    expect(resolveModelContextWindowFromRegistry("openai-codex", modelName)).toBe(model.contextWindow);
    expect(model.contextWindow).toBeGreaterThan(0);
    expect(resolveModelThinkingLevel("openai-codex", modelName, "high")).toBe("high");
  });

  it("maps Workers AI aliases to the pi-ai Cloudflare Workers AI provider", () => {
    const model = resolveModelMetadata("workers-ai", "@cf/nvidia/nemotron-3-120b-a12b");

    expect(model?.provider).toBe("cloudflare-workers-ai");
    expect(model?.id).toBe("@cf/nvidia/nemotron-3-120b-a12b");
  });

  it("resolves Workers AI context windows from pi-ai metadata", () => {
    expect(resolveModelContextWindowFromRegistry("workers-ai", "@cf/nvidia/nemotron-3-120b-a12b")).toBe(256000);
  });

  it("returns null for unknown providers and models", () => {
    expect(resolveModelMetadata("custom-provider", "custom-model")).toBeNull();
    expect(resolveModelContextWindowFromRegistry("workers-ai", "@cf/example/missing")).toBeNull();
  });
});
