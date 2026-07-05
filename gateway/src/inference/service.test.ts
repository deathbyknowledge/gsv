import { beforeEach, describe, expect, it, vi } from "vitest";

const completePiAiSimpleMock = vi.hoisted(() => vi.fn());
const streamPiAiSimpleMock = vi.hoisted(() => vi.fn());
const completeWithOpenAiCodexFetchMock = vi.hoisted(() => vi.fn());
const streamWithOpenAiCodexFetchMock = vi.hoisted(() => vi.fn());

vi.mock("./pi-ai", () => ({
  completePiAiSimple: completePiAiSimpleMock,
  streamPiAiSimple: streamPiAiSimpleMock,
}));

vi.mock("./openai-codex", () => ({
  completeWithOpenAiCodexFetch: completeWithOpenAiCodexFetchMock,
  streamWithOpenAiCodexFetch: streamWithOpenAiCodexFetchMock,
}));

import {
  createGenerationService,
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
  executor: { kind: "kernel" },
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

beforeEach(() => {
  completePiAiSimpleMock.mockReset();
  streamPiAiSimpleMock.mockReset();
  completeWithOpenAiCodexFetchMock.mockReset();
  streamWithOpenAiCodexFetchMock.mockReset();
});

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

describe("createGenerationService", () => {
  it("uses the GSV OpenAI Codex transport and forwards session affinity", async () => {
    const message = assistantMessage([{ type: "text", text: "pong" }]);
    completeWithOpenAiCodexFetchMock.mockResolvedValueOnce(message);

    await createGenerationService().generate({
      config: {
        ...CONFIG,
        provider: "openai-codex",
        model: "gpt-5.5",
        apiKey: "codex-access-token",
        openAiCodex: { accountId: "chatgpt-account-1" },
      },
      context: CONTEXT,
      sessionAffinityKey: "process-1",
    });

    expect(completeWithOpenAiCodexFetchMock).toHaveBeenCalledWith(expect.objectContaining({
      model: expect.objectContaining({
        id: "gpt-5.5",
        provider: "openai-codex",
      }),
      context: CONTEXT,
      fetch: expect.any(Function),
      options: expect.objectContaining({
        apiKey: "codex-access-token",
        openAiCodexAccountId: "chatgpt-account-1",
        transport: "sse",
        sessionId: "process-1",
      }),
    }));
    expect(completePiAiSimpleMock).not.toHaveBeenCalled();
  });

  it("reports a missing OpenAI Codex connection before calling pi-ai", async () => {
    await expect(createGenerationService().generate({
      config: {
        ...CONFIG,
        provider: "openai-codex",
        model: "gpt-5.5",
        apiKey: "",
      },
      context: CONTEXT,
    })).rejects.toThrow("OpenAI Codex is not connected");

    expect(completePiAiSimpleMock).not.toHaveBeenCalled();
  });

  it("uses the routed OpenAI Codex transport when a fetch implementation is provided", async () => {
    const message = assistantMessage([{ type: "text", text: "pong" }]);
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    completeWithOpenAiCodexFetchMock.mockResolvedValueOnce(message);

    await createGenerationService({ fetch: fetchImpl }).generate({
      config: {
        ...CONFIG,
        provider: "openai-codex",
        model: "gpt-5.4-mini",
        apiKey: "codex-access-token",
        openAiCodex: { accountId: "chatgpt-account-1" },
      },
      context: CONTEXT,
      sessionAffinityKey: "process-1",
    });

    expect(completeWithOpenAiCodexFetchMock).toHaveBeenCalledWith(expect.objectContaining({
      fetch: fetchImpl,
      context: CONTEXT,
      options: expect.objectContaining({
        apiKey: "codex-access-token",
        openAiCodexAccountId: "chatgpt-account-1",
        transport: "sse",
        sessionId: "process-1",
      }),
    }));
    expect(completePiAiSimpleMock).not.toHaveBeenCalled();
  });

  it("does not route OpenAI Codex through the generic custom-provider path when custom fields are set", async () => {
    const message = assistantMessage([{ type: "text", text: "pong" }]);
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    completeWithOpenAiCodexFetchMock.mockResolvedValueOnce(message);

    await createGenerationService({ fetch: fetchImpl }).generate({
      config: {
        ...CONFIG,
        provider: "openai-codex",
        model: "gpt-5.4-mini",
        apiKey: "codex-access-token",
        baseUrl: "https://chatgpt.com/backend-api",
        providerStyle: "openai-responses",
      },
      context: CONTEXT,
      sessionAffinityKey: "process-1",
    });

    expect(completeWithOpenAiCodexFetchMock).toHaveBeenCalledWith(expect.objectContaining({
      fetch: fetchImpl,
      context: CONTEXT,
      options: expect.objectContaining({
        apiKey: "codex-access-token",
        transport: "sse",
        sessionId: "process-1",
      }),
    }));
    expect(completePiAiSimpleMock).not.toHaveBeenCalled();
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
