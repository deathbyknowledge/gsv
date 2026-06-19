import { describe, expect, it } from "vitest";
import type { Context, Usage } from "@earendil-works/pi-ai";
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

  it("does not count image bytes as text tokens", () => {
    const contextWithImageData = (data: string): Context => ({
      systemPrompt: "You are a test process.",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe this image." },
            { type: "image", mimeType: "image/png", data },
          ],
          timestamp: 1,
        },
      ],
    });

    const smallImageEstimate = estimateContextInputTokens(contextWithImageData("AQID"));
    const largeImageEstimate = estimateContextInputTokens(contextWithImageData("A".repeat(1_000_000)));

    expect(largeImageEstimate - smallImageEstimate).toBeLessThan(10);
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

  it("includes normalized usage totals when provided", () => {
    const usageState = {
      inputTokens: 920,
      outputTokens: 80,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 1000,
      cost: {
        input: 0.00046,
        output: 0.00012,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0.00058,
        currency: "USD" as const,
        source: "model-pricing" as const,
      },
    };
    const conversationUsage = {
      ...usageState,
      inputTokens: 1840,
      outputTokens: 160,
      totalTokens: 2000,
      cost: {
        ...usageState.cost,
        input: 0.00092,
        output: 0.00024,
        total: 0.00116,
      },
      generations: 2,
    };
    const state = buildProcContextState({
      conversationId: "default",
      provider: "workers-ai",
      model: "@cf/test",
      contextWindowTokens: 4000,
      maxOutputTokens: 100,
      estimatedInputTokens: 100,
      usage: USAGE,
      usageState,
      conversationUsage,
      updatedAt: 1,
    });

    expect(state.usage?.cost?.total).toBe(0.00058);
    expect(state.conversationUsage?.cost?.total).toBe(0.00116);
    expect(state.conversationUsage?.generations).toBe(2);
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
