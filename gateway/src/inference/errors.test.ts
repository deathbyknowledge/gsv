import { describe, expect, it } from "vitest";
import {
  errorMessageFromUnknown,
  formatProviderErrorMessage,
  NON_STANDARD_PROVIDER_ERROR,
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

  it("adds account guidance for payment and quota codes", () => {
    for (const message of ["HTTP 402", "Error code: 402", "insufficient_quota", "quota_exceeded"]) {
      expect(formatProviderErrorMessage(message, {
        provider: "openai-compatible",
      })).toBe([
        `Provider account issue from openai-compatible: ${message}`,
        "Check credits, quota, or billing for the configured AI provider.",
      ].join("\n"));
    }
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

  it("extracts nested provider error messages", () => {
    expect(errorMessageFromUnknown({
      error: {
        message: "insufficient funds",
      },
    })).toBe("insufficient funds");
  });

  it("extracts provider detail fields", () => {
    expect(errorMessageFromUnknown({
      detail: "quota exceeded",
    })).toBe("quota exceeded");
  });

  it("extracts recognized provider status and code fields", () => {
    expect(errorMessageFromUnknown({
      error: {
        code: "insufficient_quota",
      },
    })).toBe("insufficient_quota");
    expect(errorMessageFromUnknown({
      status: 402,
    })).toBe("HTTP 402");
  });

  it("does not expose raw JSON for unknown structured errors", () => {
    expect(errorMessageFromUnknown({
      status: 500,
      code: "internal_error",
    })).toBe(NON_STANDARD_PROVIDER_ERROR);
  });

  it("returns a generic message for values JSON.stringify cannot render as text", () => {
    expect(errorMessageFromUnknown(undefined)).toBe(NON_STANDARD_PROVIDER_ERROR);
    expect(errorMessageFromUnknown(Symbol("provider"))).toBe(NON_STANDARD_PROVIDER_ERROR);
    expect(errorMessageFromUnknown(() => "provider failed")).toBe(NON_STANDARD_PROVIDER_ERROR);
  });

  it("handles cyclic objects without exposing raw JSON", () => {
    const error: { self?: unknown } = {};
    error.self = error;

    expect(errorMessageFromUnknown(error)).toBe(NON_STANDARD_PROVIDER_ERROR);
  });
});
