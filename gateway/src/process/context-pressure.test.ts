import { describe, expect, it } from "vitest";
import type { Context, Usage } from "@earendil-works/pi-ai";
import {
  buildProcContextState,
  estimateContextInputTokens,
  measureContextInputTokens,
} from "./context-pressure";
import { tagAssistantContextIdentity } from "./context-message-metadata";

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

const BASE_CONTEXT: Context = {
  systemPrompt: "You are a test process.",
  messages: [
    {
      role: "user",
      content: "Summarize this short message.",
      timestamp: 1,
    },
  ],
};

describe("context pressure", () => {
  it("estimates input tokens from the assembled model context", () => {
    expect(estimateContextInputTokens(BASE_CONTEXT)).toBeGreaterThan(0);
  });

  // SAFETY: test fixture is constructed with the asserted domain shape.
  it("estimates image tokens without counting encoded bytes as text", () => {
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

    const textOnlyEstimate = estimateContextInputTokens(BASE_CONTEXT);
    const smallImageEstimate = estimateContextInputTokens(contextWithImageData("AQID"));
    const largeImageEstimate = estimateContextInputTokens(
      contextWithImageData("A".repeat(1_000_000)),
    );

    expect(smallImageEstimate).toBeGreaterThan(textOnlyEstimate + 1_000);
    expect(largeImageEstimate).toBe(smallImageEstimate);
  });

  it("reserves configured output tokens and exposes absolute remaining input", () => {
    const state = buildProcContextState({
      revision: 3,
      provider: "openai",
      model: "gpt-test",
      contextWindowTokens: 1000,
      maxOutputTokens: 200,
      measurement: {
        estimatedInputTokens: 400,
        inputTokens: 400,
        confirmedInputTokens: 0,
        estimatedTrailingInputTokens: 400,
        source: "estimate",
      },
      updatedAt: 1,
    });

    expect(state.revision).toBe(3);
    expect(state.inputBudgetTokens).toBe(800);
    expect(state.availableInputTokens).toBe(800);
    expect(state.remainingInputTokens).toBe(400);
    expect(state.pressure).toBe(0.5);
    expect(state.level).toBe("ok");
    expect(state.source).toBe("estimate");
  });

  it("uses provider prompt usage only for the exact request snapshot", () => {
    const cachedUsage: Usage = {
      ...USAGE,
      input: 120,
      cacheRead: 800,
      totalTokens: 1_000,
    };
    const measurement = measureContextInputTokens(
      BASE_CONTEXT,
      { provider: "openai", model: "gpt-test" },
      cachedUsage,
    );

    expect(measurement).toMatchObject({
      inputTokens: 920,
      confirmedInputTokens: 920,
      estimatedTrailingInputTokens: 0,
      source: "provider",
    });
  });

  it("uses matching assistant usage as a confirmed prefix of the current context", () => {
    const context: Context = {
      ...BASE_CONTEXT,
      messages: [
        ...BASE_CONTEXT.messages,
        {
          role: "assistant",
          content: [{ type: "text", text: "Done." }],
          api: "openai-responses",
          provider: "openai",
          model: "gpt-test",
          usage: USAGE,
          stopReason: "stop",
          timestamp: 2,
        },
      ],
    };
    const measurement = measureContextInputTokens(
      context,
      { provider: "openai", model: "gpt-test" },
    );
    const state = buildProcContextState({
      revision: 1,
      provider: "openai",
      model: "gpt-test",
      reasoning: "high",
      contextWindowTokens: 1000,
      maxOutputTokens: 100,
      measurement,
      updatedAt: 1,
    });

    expect(state.inputTokens).toBe(1000);
    expect(state.confirmedInputTokens).toBe(1000);
    expect(state.estimatedTrailingInputTokens).toBe(0);
    expect(state.reasoning).toBe("high");
    expect(state.remainingInputTokens).toBe(0);
    expect(state.level).toBe("full");
    expect(state.source).toBe("provider");
  });

  it("does not reuse matching provider usage from a different context epoch", () => {
    const assistant = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "Old answer" }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-test",
      usage: USAGE,
      stopReason: "stop" as const,
      timestamp: 2,
    };
    tagAssistantContextIdentity(assistant, "epoch-old", "generation-context:ordinary");
    const context: Context = {
      ...BASE_CONTEXT,
      messages: [...BASE_CONTEXT.messages, assistant],
    };

    const measurement = measureContextInputTokens(context, {
      provider: "openai",
      model: "gpt-test",
      contextEpochId: "epoch-current",
    });

    expect(measurement.source).toBe("estimate");
    expect(measurement.confirmedInputTokens).toBe(0);
  });

  it("does not reuse usage from a different prompt and tool shape in the same epoch", () => {
    const assistant = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "Delegated answer" }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-test",
      usage: USAGE,
      stopReason: "stop" as const,
      timestamp: 2,
    };
    tagAssistantContextIdentity(
      assistant,
      "epoch-current",
      "generation-context:delegated",
    );
    const context: Context = {
      ...BASE_CONTEXT,
      messages: [...BASE_CONTEXT.messages, assistant],
    };

    const measurement = measureContextInputTokens(context, {
      provider: "openai",
      model: "gpt-test",
      contextEpochId: "epoch-current",
      generationContextId: "generation-context:interactive",
    });

    expect(measurement.source).toBe("estimate");
    expect(measurement.confirmedInputTokens).toBe(0);
  });

  it("adds trailing tool results without discarding the confirmed prefix", () => {
    const context: Context = {
      ...BASE_CONTEXT,
      messages: [
        ...BASE_CONTEXT.messages,
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-1", name: "Read", arguments: {} }],
          api: "openai-responses",
          provider: "openai",
          model: "gpt-test",
          usage: USAGE,
          stopReason: "toolUse",
          timestamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "Read",
          content: [{ type: "text", text: "x".repeat(400) }],
          isError: false,
          timestamp: 3,
        },
      ],
    };

    const measurement = measureContextInputTokens(
      context,
      { provider: "openai", model: "gpt-test" },
    );
    expect(measurement).toMatchObject({
      confirmedInputTokens: 1000,
      source: "mixed",
    });
    expect(measurement.estimatedTrailingInputTokens).toBeGreaterThan(115);
    expect(measurement.inputTokens).toBe(
      measurement.confirmedInputTokens + measurement.estimatedTrailingInputTokens,
    );
  });

  it("does not reuse provider tokenization after the configured model changes", () => {
    const context: Context = {
      ...BASE_CONTEXT,
      messages: [
        ...BASE_CONTEXT.messages,
        {
          role: "assistant",
          content: [{ type: "text", text: "Done." }],
          api: "openai-responses",
          provider: "openai",
          model: "gpt-old",
          usage: USAGE,
          stopReason: "stop",
          timestamp: 2,
        },
      ],
    };

    const measurement = measureContextInputTokens(
      context,
      { provider: "anthropic", model: "claude-new" },
    );
    expect(measurement.source).toBe("estimate");
    expect(measurement.confirmedInputTokens).toBe(0);
  });

  // SAFETY: test fixture is constructed with the asserted domain shape.
  it("includes normalized usage totals without treating them as live context", () => {
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
        // SAFETY: test fixture is constructed with the asserted domain shape.
        currency: "USD" as const,
        // SAFETY: test fixture is constructed with the asserted domain shape.
        source: "model-pricing" as const,
      },
    };
    const historyUsage = {
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
      revision: 1,
      provider: "workers-ai",
      model: "@cf/test",
      contextWindowTokens: 4000,
      maxOutputTokens: 100,
      measurement: measureContextInputTokens(BASE_CONTEXT),
      usageState,
      historyUsage,
      updatedAt: 1,
    });

    expect(state.inputTokens).not.toBe(usageState.totalTokens);
    expect(state.usage?.cost?.total).toBe(0.00058);
    expect(state.historyUsage?.cost?.total).toBe(0.00116);
    expect(state.historyUsage?.generations).toBe(2);
  });

  it("keeps remaining input unknown without a context window", () => {
    const state = buildProcContextState({
      revision: 1,
      provider: "custom",
      model: "unknown",
      contextWindowTokens: null,
      maxOutputTokens: 100,
      measurement: measureContextInputTokens(BASE_CONTEXT),
      updatedAt: 1,
    });

    expect(state.inputBudgetTokens).toBeNull();
    expect(state.remainingInputTokens).toBeNull();
    expect(state.pressure).toBeNull();
    expect(state.level).toBe("unknown");
  });
});
