import { describe, expect, it } from "vitest";
import {
  describeGeneratedTextFailure,
  extractGeneratedText,
  resolveGenerationOptions,
  resolveGenerationTimeoutMs,
} from "./service";
import type { AiConfigResult } from "../syscalls/ai";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";

function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "test",
    provider: "test",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

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
      config: CONFIG,
      context: CONTEXT,
    });

    expect(result.reasoning).toBe("high");
    expect(result.maxTokens).toBe(4096);
  });

  it("clamps unsupported reasoning for Workers AI models", () => {
    const result = resolveGenerationOptions({
      config: {
        ...CONFIG,
        provider: "workers-ai",
        model: "@cf/nvidia/nemotron-3-120b-a12b",
        reasoning: "xhigh",
      },
      context: CONTEXT,
    });

    expect(result.reasoning).toBe("high");
  });

  it("clamps unsupported reasoning for pi-ai models", () => {
    const result = resolveGenerationOptions({
      config: {
        ...CONFIG,
        provider: "google",
        model: "gemini-3-pro-preview",
        reasoning: "medium",
      },
      context: CONTEXT,
    });

    expect(result.reasoning).toBe("high");
  });

  it("uses the closest supported reasoning when a model cannot turn reasoning off", () => {
    const result = resolveGenerationOptions({
      config: {
        ...CONFIG,
        provider: "openai",
        model: "gpt-5",
        reasoning: "off",
      },
      context: CONTEXT,
    });

    expect(result.reasoning).toBe("minimal");
  });

  it("disables reasoning and constrains tokens when explicitly requested", () => {
    const result = resolveGenerationOptions({
      config: CONFIG,
      context: CONTEXT,
      options: {
        maxTokens: 768,
        reasoning: "off",
      },
    });

    expect(result.reasoning).toBeUndefined();
    expect(result.maxTokens).toBe(768);
  });
});

describe("extractGeneratedText", () => {
  it("returns the joined text blocks when present", () => {
    const message = assistantMessage([
      { type: "thinking", thinking: "weighing options" },
      { type: "text", text: "Hello " },
      { type: "text", text: "world" },
    ]);

    expect(extractGeneratedText(message)).toBe("Hello world");
  });

  it("falls back to reasoning when a reasoning model emits no text block", () => {
    const message = assistantMessage([
      { type: "thinking", thinking: "  Summary of the conversation.  " },
    ]);
    message.stopReason = "error";
    message.errorMessage = "Workers AI returned an empty response";

    expect(extractGeneratedText(message)).toBe("Summary of the conversation.");
  });

  it("returns empty string when there is neither text nor reasoning", () => {
    expect(extractGeneratedText(assistantMessage([]))).toBe("");
  });
});

describe("describeGeneratedTextFailure", () => {
  it("preserves provider billing errors from empty error responses", () => {
    const message = assistantMessage([]);
    message.stopReason = "error";
    message.errorMessage = "insufficient funds";

    expect(describeGeneratedTextFailure({
      config: {
        provider: "deepseek",
        model: "deepseek-chat",
      },
    }, message)).toBe([
      "Provider account issue from deepseek/deepseek-chat: insufficient funds",
      "Check credits, quota, or billing for the configured AI provider.",
    ].join("\n"));
  });

  it("falls back to the generic no-text message when there is no provider error", () => {
    expect(describeGeneratedTextFailure({
      config: {
        provider: "test",
        model: "test",
      },
    }, assistantMessage([]))).toBe("Generation returned no text");
  });
});

describe("resolveGenerationTimeoutMs", () => {
  it("uses the configured generation timeout", () => {
    expect(resolveGenerationTimeoutMs(CONFIG)).toBe(180000);
  });

  it("lets callers provide a shorter generation timeout", () => {
    expect(resolveGenerationTimeoutMs(CONFIG, { timeoutMs: 1000 })).toBe(1000);
  });

  it("defaults legacy persisted configs without a generation timeout", () => {
    const { generationTimeoutMs: _generationTimeoutMs, ...legacyConfig } = CONFIG;

    expect(resolveGenerationTimeoutMs(legacyConfig as AiConfigResult)).toBe(180000);
  });
});
