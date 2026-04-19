import { describe, expect, it } from "vitest";
import { resolveGenerationOptions } from "./service";
import type { AiConfigResult } from "../syscalls/ai";
import type { Context } from "@mariozechner/pi-ai";

const CONFIG: AiConfigResult = {
  provider: "anthropic",
  model: "claude-sonnet-4-20250514",
  apiKey: "test-key",
  reasoning: "high",
  maxTokens: 4096,
  systemPrompt: "",
  maxContextBytes: 32768,
};

const CONTEXT: Context = {
  systemPrompt: "",
  messages: [],
};

describe("resolveGenerationOptions", () => {
  it("preserves configured reasoning for chat replies", () => {
    const result = resolveGenerationOptions({
      purpose: "chat.reply",
      config: CONFIG,
      context: CONTEXT,
    });

    expect(result.reasoning).toBe("high");
    expect(result.maxTokens).toBe(4096);
  });

  it("disables reasoning and constrains tokens for checkpoint commit messages", () => {
    const result = resolveGenerationOptions({
      purpose: "checkpoint.commit_message",
      config: CONFIG,
      context: CONTEXT,
    });

    expect(result.reasoning).toBeUndefined();
    expect(result.maxTokens).toBe(128);
  });

  it("disables reasoning and constrains tokens for checkpoint summaries", () => {
    const result = resolveGenerationOptions({
      purpose: "checkpoint.summary",
      config: CONFIG,
      context: CONTEXT,
    });

    expect(result.reasoning).toBeUndefined();
    expect(result.maxTokens).toBe(768);
  });
});
