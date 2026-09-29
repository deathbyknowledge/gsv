type KernelTestValue<T = string | number | boolean | null | undefined> = T;

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KernelContext } from "../context";

import * as ai from "../ai";
const handleAiTextGenerateMock = vi.spyOn(ai, "handleAiTextGenerate");

import { handleSysSetupAssist } from "./setup-assist";

beforeEach(() => {
  handleAiTextGenerateMock.mockReset();
});

function makeContext(): KernelContext {
  // SAFETY: test fixture is constructed with the asserted kernel domain shape.
  return {
    auth: {
      isSetupMode: vi.fn(() => true),
    },
  // SAFETY: test fixture is constructed with the asserted kernel domain shape.
  } as KernelContext;
}

function assistantMessage(overrides: Record<string, KernelTestValue> = {}) {
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

    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    await expect(handleSysSetupAssist({
      lane: "ai",
      draft: {},
      messages: [],
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as any, makeContext())).rejects.toThrow("insufficient funds");
  });
});
