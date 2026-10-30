import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "@humansandmachines/gsv/services/inference-context";
import {
  describeAssistantResponseFailure,
  isRetryableAssistantResponseFailure,
  isRetryableGenerationErrorMessage,
} from "./output";

describe("generation output classification", () => {
  const response: AssistantMessage = {
    role: "assistant", content: [], api: "openai-completions", provider: "test",
    model: "test", stopReason: "stop", timestamp: 1,
  };

  it.each<{ content: AssistantMessage["content"] }>([
    { content: [] },
    { content: [{ type: "text", text: " \n\t" }] },
    { content: [{ type: "thinking", thinking: "" }, { type: "text", text: "" }] },
  ])("classifies empty blocks as an empty response", ({ content }) => {
    const empty = { ...response, content };
    const failure = describeAssistantResponseFailure(empty);
    expect(failure).toBe("LLM returned empty response");
    expect(isRetryableAssistantResponseFailure(empty, failure!)).toBe(true);
  });

  it.each<{ content: AssistantMessage["content"] }>([
    { content: [{ type: "thinking", thinking: "I should wait." }] },
    { content: [{ type: "thinking", thinking: "", redacted: true }] },
  ])("requires an action after reasoning, including redacted reasoning", ({ content }) => {
    const reasoning = { ...response, content };
    const failure = describeAssistantResponseFailure(reasoning);
    expect(failure).toBe("LLM returned reasoning but no final response");
    expect(isRetryableAssistantResponseFailure(reasoning, failure!)).toBe(true);
  });

  it("distinguishes an output limit from a completed reasoning-only response", () => {
    expect(describeAssistantResponseFailure({
      ...response, stopReason: "length", content: [{ type: "thinking", thinking: "Still planning" }],
    })).toBe("LLM reached the output token limit without text or a tool call");
  });

  it.each(["Send", "Shell"])("accepts an explicit silent yield through %s", (name) => {
    expect(describeAssistantResponseFailure({
      ...response, stopReason: "toolUse", content: [
        { type: "thinking", thinking: "There is nothing to send." },
        { type: "toolCall", id: "silent-yield", name, arguments: name === "Send" ? { yield: true } : { input: "yield" } },
      ],
    })).toBeNull();
  });
});

describe("generation output retries", () => {
  it.each([
    "ReadableStream received over RPC disconnected prematurely.",
    "Network connection lost.",
    "Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request.",
    // Cloudflare's own transient failure, as a Ship's services all reported during a brief platform stall.
    "Error: internal error; reference = rnkieip154sca78sk75m5h1b",
  ])("retries an interrupted inference transport: %s", (detail) => {
    const failure = `Inference reference: diagnostic-id\n${detail}`;
    const response: AssistantMessage = {
      role: "assistant", content: [], api: "gsv-inference", provider: "gsv", model: "default",
      stopReason: "error", errorMessage: failure, timestamp: 1,
    };
    expect(isRetryableGenerationErrorMessage(failure)).toBe(true);
    expect(isRetryableAssistantResponseFailure(response, failure)).toBe(true);
    expect(isRetryableAssistantResponseFailure({ ...response, stopReason: "aborted" }, failure)).toBe(false);
  });

  it.each([
    "Durable Object's isolate exceeded its memory limit and was reset.",
    "Inference request identity has already been used",
    "No API key for provider: deepseek",
  ])("does not replay a permanent or resource failure: %s", (failure) => {
    expect(isRetryableGenerationErrorMessage(failure)).toBe(false);
  });

  it("retries transient Cloudflare subrequest-depth failures", () => {
    const failure =
      "Subrequest depth limit exceeded. This request recursed through Workers too many times.";
    const response: AssistantMessage = {
      role: "assistant",
      content: [],
      api: "openai-completions",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      stopReason: "error",
      errorMessage: failure,
      timestamp: Date.now(),
    };

    expect(isRetryableGenerationErrorMessage(failure)).toBe(true);
    expect(isRetryableAssistantResponseFailure(response, failure)).toBe(true);
  });

  it("does not retry permanent provider configuration failures", () => {
    const failure = "No API key for provider: deepseek";

    expect(isRetryableGenerationErrorMessage(failure)).toBe(false);
  });
});
