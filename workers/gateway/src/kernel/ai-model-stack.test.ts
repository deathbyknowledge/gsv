import { describe, expect, it } from "vitest";
import {
  aiModelApiKeyConfigKey,
  orderAiModelStack,
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
});
