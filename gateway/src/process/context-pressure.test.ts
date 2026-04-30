import { describe, expect, it } from "vitest";
import type { Context, Usage } from "@mariozechner/pi-ai";
import {
  buildProcContextState,
  estimateContextInputTokens,
} from "./context-pressure";

const USAGE: Usage = {
  input: 920,
  output: 80,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 1000,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

describe("context pressure", () => {
  it("estimates input tokens from the assembled model context", () => {
    const context: Context = {
      systemPrompt: "You are a test process.",
      messages: [
        {
          role: "user",
          content: "Summarize this short message.",
          timestamp: 1,
        },
      ],
    };

    expect(estimateContextInputTokens(context)).toBeGreaterThan(0);
  });

  it("reserves configured output tokens when calculating pressure", () => {
    const state = buildProcContextState({
      conversationId: "default",
      provider: "openai",
      model: "gpt-test",
      contextWindowTokens: 1000,
      maxOutputTokens: 200,
      estimatedInputTokens: 400,
      updatedAt: 1,
    });

    expect(state.availableInputTokens).toBe(800);
    expect(state.pressure).toBe(0.5);
    expect(state.level).toBe("ok");
    expect(state.source).toBe("estimate");
  });

  it("uses provider usage when it is available", () => {
    const state = buildProcContextState({
      conversationId: "default",
      provider: "workers-ai",
      model: "@cf/test",
      contextWindowTokens: 1000,
      maxOutputTokens: 100,
      estimatedInputTokens: 100,
      usage: USAGE,
      updatedAt: 1,
    });

    expect(state.inputTokens).toBe(1000);
    expect(state.outputTokens).toBe(80);
    expect(state.totalTokens).toBe(1000);
    expect(state.level).toBe("full");
    expect(state.source).toBe("provider");
  });

  it("keeps pressure unknown without a context window", () => {
    const state = buildProcContextState({
      conversationId: "default",
      provider: "custom",
      model: "unknown",
      contextWindowTokens: null,
      maxOutputTokens: 100,
      estimatedInputTokens: 100,
      updatedAt: 1,
    });

    expect(state.availableInputTokens).toBeNull();
    expect(state.pressure).toBeNull();
    expect(state.level).toBe("unknown");
  });
});
