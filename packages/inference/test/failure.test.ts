import { describe, expect, it } from "vitest";
import {
  abandonedFailure,
  classifyProviderFailure,
  protocolFailure,
} from "../src/failure";

describe("managed inference failure classification", () => {
  it("classifies provider responses by bounded status metadata", () => {
    expect(classifyProviderFailure({
      stage: "provider",
      statusCode: 429,
    })).toEqual({
      kind: "rate_limited",
      stage: "provider",
      retryable: true,
      providerStatusCode: 429,
    });
    expect(classifyProviderFailure({
      stage: "provider",
      statusCode: 503,
    })).toMatchObject({
      kind: "provider_unavailable",
      retryable: true,
    });
    expect(classifyProviderFailure({
      stage: "provider",
      statusCode: 413,
    })).toMatchObject({
      kind: "context_overflow",
      retryable: false,
    });
  });

  it("uses safe categories when a response body refines the status", () => {
    expect(classifyProviderFailure({
      stage: "provider",
      statusCode: 429,
      message: "service is temporarily at capacity",
    })).toMatchObject({
      kind: "capacity",
      retryable: true,
      providerStatusCode: 429,
    });
    expect(classifyProviderFailure({
      stage: "stream",
      statusCode: 200,
      message: "maximum context length exceeded",
    })).toMatchObject({
      kind: "context_overflow",
      stage: "stream",
      providerStatusCode: 200,
    });
  });

  it("distinguishes timeouts, transport failures, and lifecycle failures", () => {
    expect(classifyProviderFailure({
      stage: "stream",
      statusCode: 200,
      timedOut: true,
    })).toMatchObject({ kind: "timeout", retryable: true });
    expect(classifyProviderFailure({
      stage: "provider",
      transportFailed: true,
    })).toEqual({
      kind: "network",
      stage: "provider",
      retryable: true,
    });
    expect(protocolFailure()).toEqual({
      kind: "protocol",
      stage: "stream",
      retryable: true,
    });
    expect(abandonedFailure()).toEqual({
      kind: "timeout",
      stage: "lifecycle",
      retryable: true,
    });
  });

});
