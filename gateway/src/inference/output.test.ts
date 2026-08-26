import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  isRetryableAssistantResponseFailure,
  isRetryableGenerationErrorMessage,
} from "./output";

describe("generation output retries", () => {
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
