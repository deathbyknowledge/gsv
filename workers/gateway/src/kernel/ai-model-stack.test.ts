import { describe, expect, it } from "vitest";
import {
  aiModelApiKeyConfigKey,
  orderAiModelStack,
  orderEffectiveAiModels,
  layerAiModelStacks,
  parseAiModelOrder,
  parseAiModelStack,
  userAiModelsConfigKey,
} from "./ai-model-stack";

describe("AI model stacks", () => {
  const raw = JSON.stringify({
    version: 1,
    models: [
      {
        id: "primary",
        name: "Primary",
        provider: " openrouter ",
        model: " openai/gpt-5-mini ",
        maxTokens: 32_768,
      },
      {
        id: "local-backup",
        name: "Local backup",
        provider: "custom",
        model: "qwen",
        baseUrl: " http://127.0.0.1:8080/v1 ",
      },
    ],
  });

  it("parses complete ordered entries without copying credentials into the list", () => {
    expect(parseAiModelStack(raw)).toEqual({
      version: 1,
      models: [
        {
          id: "primary",
          name: "Primary",
          provider: "openrouter",
          model: "openai/gpt-5-mini",
          maxTokens: 32_768,
        },
        {
          id: "local-backup",
          name: "Local backup",
          provider: "custom",
          model: "qwen",
          baseUrl: "http://127.0.0.1:8080/v1",
        },
      ],
    });
  });

  it("rejects malformed or duplicate stable ids as one invalid stack", () => {
    expect(parseAiModelStack("not json")).toBeNull();
    expect(parseAiModelStack(JSON.stringify({
      version: 1,
      models: [
        { id: "same", name: "A", provider: "a", model: "a" },
        { id: "same", name: "B", provider: "b", model: "b" },
      ],
    }))).toBeNull();
    expect(parseAiModelStack(JSON.stringify({
      version: 1,
      models: [{
        id: "embedded-secret",
        name: "Embedded secret",
        provider: "openai",
        model: "gpt-5.4",
        apiKey: "must-live-at-the-entry-secret-path",
      }],
    }))).toBeNull();
  });

  it("moves a preferred entry to the front without duplicating it", () => {
    const stack = parseAiModelStack(raw)!;
    expect(orderAiModelStack(stack, "local-backup").map((model) => model.id))
      .toEqual(["local-backup", "primary"]);
    expect(orderAiModelStack(stack, "missing").map((model) => model.id))
      .toEqual(["primary", "local-backup"]);
  });

  it("constructs account-scoped list and credential keys", () => {
    const key = userAiModelsConfigKey(1000);
    expect(key).toBe("users/1000/ai/models");
    expect(aiModelApiKeyConfigKey(key, "primary"))
      .toBe("users/1000/ai/models/primary/api_key");
  });

  it("applies ID order after layering and preserves credential ownership", () => {
    const entries = layerAiModelStacks({
      personal: parseAiModelStack(raw), personalKey: userAiModelsConfigKey(1000),
      system: { version: 1, models: [{ id: "shared", name: "Shared", provider: "custom", model: "shared" }] },
      base: [{ id: "base", name: "Base", provider: "workers-ai", model: "base" }],
    });
    const result = orderEffectiveAiModels(entries, "local-backup", ["removed", "base", "shared"]);
    expect(result.map((item) => item.entry.id)).toEqual(["local-backup", "base", "shared", "primary"]);
    expect(result.map((item) => item.credentialKey)).toEqual([
      "users/1000/ai/models/local-backup/api_key", null, "config/ai/models/shared/api_key", "users/1000/ai/models/primary/api_key",
    ]);
    expect(result[1]).toBe(entries[3]);
    expect(entries.map((item) => item.entry.id)).toEqual(["primary", "local-backup", "shared", "base"]);
  });

  it("validates order references without requiring those models to exist yet", () => {
    expect(parseAiModelOrder('[" future-model ","included"]')).toEqual(["future-model", "included"]);
    expect(parseAiModelOrder("[]")).toEqual([]);
    for (const raw of ['["same","same"]', '["bad/id"]', '[42]', '{}', 'null', 'malformed']) {
      expect(parseAiModelOrder(raw)).toBeNull();
    }
  });
});
