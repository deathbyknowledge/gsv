import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "@humansandmachines/gsv/services/inference-context";
import { isContextOverflow } from "./context-overflow";

function message(partial: Partial<AssistantMessage>): AssistantMessage {
  return { role: "assistant", content: [], api: "test", provider: "test", model: "test", stopReason: "error", timestamp: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, ...partial };
}

describe("context pressure without a provider SDK", () => {
  it.each([
    "prompt is too long: 200001 tokens > 200000 maximum",
    "request_too_large",
    "Your input exceeds the model's maximum context length of 128,000 tokens",
    "exceeds model's maximum context length (128000)",
    "input token count exceeds the maximum",
    "maximum prompt length is 100 but request contains 101",
    "reduce the length of the messages",
    "413 status code (no body)",
    "The input (1001 tokens) is longer than the model's context length (1000 tokens)",
    "Prompt has 2,001 tokens, but the configured context size is 2,000 tokens",
    "model_context_window_exceeded",
    "Range of input length should be [1, 1000]",
  ])("recognizes historical context failure: %s", (errorMessage) => {
    expect(isContextOverflow(message({ errorMessage }))).toBe(true);
  });

  it.each(["Throttling error: too many tokens", "Service unavailable: too many tokens", "rate limit: token limit exceeded", "too many requests", "invalid API key", "insufficient quota"])("does not compact for %s", (errorMessage) => {
    expect(isContextOverflow(message({ errorMessage }))).toBe(false);
  });

  it("includes cached input in silent overflow, and requires zero output for length pressure", () => {
    const usage = { ...message({}).usage, input: 500, cacheRead: 501 };
    expect(isContextOverflow(message({ usage, stopReason: "stop" }), 1000)).toBe(true);
    expect(isContextOverflow(message({ usage: { ...usage, cacheRead: 500 }, stopReason: "stop" }), 1000)).toBe(false);
    expect(isContextOverflow(message({ usage: { ...usage, cacheRead: 490 }, stopReason: "length" }), 1000)).toBe(true);
    expect(isContextOverflow(message({ usage: { ...usage, output: 1 }, stopReason: "length" }), 1000)).toBe(false);
  });
});
