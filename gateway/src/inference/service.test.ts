import { describe, expect, it } from "vitest";
import { resolveGenerationOptions, resolveGenerationTimeoutMs } from "./service";
import type { AiConfigResult } from "../syscalls/ai";
import type { Context } from "@earendil-works/pi-ai";

const CONFIG: AiConfigResult = {
  provider: "anthropic",
  model: "claude-sonnet-4-20250514",
  apiKey: "test-key",
  reasoning: "high",
  maxTokens: 4096,
  contextWindowTokens: 200000,
  contextWindowSource: "model",
  maxContextBytes: 32768,
  generationTimeoutMs: 180000,
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

describe("resolveGenerationTimeoutMs", () => {
  it("uses the configured generation timeout", () => {
    expect(resolveGenerationTimeoutMs(CONFIG)).toBe(180000);
  });

  it("defaults legacy persisted configs without a generation timeout", () => {
    const { generationTimeoutMs: _generationTimeoutMs, ...legacyConfig } = CONFIG;

    expect(resolveGenerationTimeoutMs(legacyConfig as AiConfigResult)).toBe(180000);
  });
});
