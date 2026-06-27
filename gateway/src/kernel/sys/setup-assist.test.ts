import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KernelContext } from "../context";

const handleAiTextGenerateMock = vi.hoisted(() => vi.fn());

vi.mock("../ai", () => ({
  handleAiTextGenerate: handleAiTextGenerateMock,
}));

import { handleSysSetupAssist } from "./setup-assist";

beforeEach(() => {
  handleAiTextGenerateMock.mockReset();
});

function makeContext(): KernelContext {
  return {
    auth: {
      isSetupMode: vi.fn(() => true),
    },
  } as unknown as KernelContext;
}

function assistantMessage(overrides: Record<string, unknown> = {}) {
  return {
    role: "assistant",
    content: [],
    api: "test",
    provider: "deepseek",
    model: "deepseek-chat",
    usage: {
      input: 1,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 1,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    ...overrides,
  };
}

describe("handleSysSetupAssist", () => {
  it("surfaces generation errors before parsing setup JSON", async () => {
    handleAiTextGenerateMock.mockResolvedValueOnce({
      provider: "deepseek",
      model: "deepseek-chat",
      message: assistantMessage({
        stopReason: "error",
        errorMessage: "insufficient funds",
      }),
    });

    await expect(handleSysSetupAssist({
      lane: "ai",
      draft: {},
      messages: [],
    } as any, makeContext())).rejects.toThrow("insufficient funds");
  });
});
