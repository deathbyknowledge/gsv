import { describe, expect, it } from "vitest";
import {
  errorMessageFromUnknown,
  formatProviderErrorMessage,
} from "./errors";

describe("formatProviderErrorMessage", () => {
  it("adds account guidance for billing and credit failures", () => {
    expect(formatProviderErrorMessage("insufficient funds", {
      provider: "deepseek",
      model: "deepseek-chat",
    })).toBe([
      "Provider account issue from deepseek/deepseek-chat: insufficient funds",
      "Check credits, quota, or billing for the configured AI provider.",
    ].join("\n"));
  });

  it("adds retry guidance for provider rate limits", () => {
    expect(formatProviderErrorMessage("Too many requests", {
      provider: "openrouter",
    })).toBe([
      "Provider rate limit from openrouter: Too many requests",
      "Wait and retry, or switch to another configured AI provider or model.",
    ].join("\n"));
  });

  it("does not double-prefix already normalized provider errors", () => {
    const normalized = [
      "Provider account issue from deepseek/deepseek-chat: insufficient funds",
      "Check credits, quota, or billing for the configured AI provider.",
    ].join("\n");

    expect(formatProviderErrorMessage(normalized)).toBe(normalized);
  });

  it("preserves unrelated provider errors", () => {
    expect(formatProviderErrorMessage("invalid api key")).toBe("invalid api key");
  });
});

describe("errorMessageFromUnknown", () => {
  it("extracts Error messages", () => {
    expect(errorMessageFromUnknown(new Error("provider failed"))).toBe("provider failed");
  });
});
