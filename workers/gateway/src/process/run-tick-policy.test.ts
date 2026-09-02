import { describe, expect, it } from "vitest";
import type { AiConfigResult } from "@humansandmachines/gsv/protocol";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  classifyAssistantTurn,
  nextAiConfigFallback,
} from "./run-tick-policy";

function assistant(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "test",
    provider: "test",
    model: "test",
    stopReason: "stop",
    timestamp: 1,
  };
}

function config(overrides: Partial<AiConfigResult> = {}): AiConfigResult {
  return {
    executor: { kind: "process", pid: "policy-test" },
    provider: "primary",
    model: "primary-model",
    apiKey: "primary-key",
    maxTokens: 1_000,
    contextWindowTokens: 32_000,
    contextWindowSource: "config",
    maxContextBytes: 32_768,
    generationTimeoutMs: 180_000,
    ...overrides,
  };
}

describe("run tick policy", () => {
  it("classifies assistant turns without overlapping continuation categories", () => {
    const runControl = {
      type: "toolCall" as const,
      id: "yield-call",
      name: "Shell",
      arguments: { input: "yield" },
    };
    const read = {
      type: "toolCall" as const,
      id: "read-call",
      name: "Read",
      arguments: { path: "/tmp/value" },
    };
    const forged = {
      type: "toolCall" as const,
      id: "forged-call",
      name: "RootAccess",
      arguments: {},
    };

    expect(classifyAssistantTurn(assistant([runControl]), ["Read"]).kind).toBe("run-control");
    expect(classifyAssistantTurn(assistant([runControl, read]), ["Read"]).kind).toBe(
      "invalid-run-control",
    );
    expect(classifyAssistantTurn(assistant([read, forged]), ["Read"]).kind).toBe("tools");
    expect(classifyAssistantTurn(assistant([forged]), ["Read"]).kind).toBe("unoffered-tools");
    expect(
      classifyAssistantTurn(assistant([{ type: "text", text: "done" }]), ["Read"]),
    ).toMatchObject({ kind: "terminal", text: "done" });
  });

  it("skips duplicate fallback stacks without carrying fallback chains", () => {
    const primary = config({
      fallbacks: [
        {
          provider: "primary",
          model: "primary-model",
          apiKey: "primary-key",
          maxTokens: 2_000,
          contextWindowTokens: 64_000,
          contextWindowSource: "config",
          generationTimeoutMs: 90_000,
        },
        {
          provider: "backup",
          model: "backup-model",
          apiKey: "backup-key",
          maxTokens: 2_000,
          contextWindowTokens: 64_000,
          contextWindowSource: "config",
          generationTimeoutMs: 90_000,
        },
      ],
    });

    expect(nextAiConfigFallback(primary, primary, primary.fallbacks ?? [], 0)).toMatchObject({
      nextIndex: 2,
      config: {
        provider: "backup",
        model: "backup-model",
        apiKey: "backup-key",
      },
    });
    expect(
      nextAiConfigFallback(primary, primary, primary.fallbacks ?? [], 0)?.config,
    ).not.toHaveProperty("fallbacks");
  });
});
