import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KernelContext } from "../context";

const handleAiTextGenerateMock = vi.hoisted(() => vi.fn());

vi.mock("../ai", () => ({
  handleAiTextGenerate: handleAiTextGenerateMock,
}));

import { handleSysSetupAssist } from "./setup-assist";
import { SetupTokenError } from "../../auth/setup-token";

beforeEach(() => {
  handleAiTextGenerateMock.mockReset();
});

function makeContext(
  setupTokenHash?: string,
  setupTokenExpiresAt = "2000000000000",
  managedSetupTokenPolicy?: KernelContext["managedSetupTokenPolicy"],
): KernelContext {
  return {
    env: setupTokenHash === undefined
      ? {}
      : {
          GSV_SETUP_TOKEN_HASH: setupTokenHash,
          GSV_SETUP_TOKEN_EXPIRES_AT: setupTokenExpiresAt,
        },
    auth: {
      isSetupMode: vi.fn(() => true),
    },
    consumeSetupAssistAllowance: vi.fn(),
    managedSetupTokenPolicy,
  } as unknown as KernelContext;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
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

function draft() {
  return {
    lane: "quick",
    mode: "guided",
    stage: "details",
    detailStep: "account",
    account: { username: "alice", agentName: "gsv", password: "secret", passwordConfirm: "secret" },
    admin: { mode: "same", password: "secret", passwordConfirm: "secret" },
    system: { timezone: "UTC" },
    ai: { enabled: false, provider: "", model: "", apiKey: "secret" },
    source: { enabled: false, value: "", ref: "" },
    device: { enabled: false, deviceId: "", label: "", expiryDays: "" },
  } as const;
}

describe("handleSysSetupAssist", () => {
  it("authorizes the managed setup token before spending inference or budget", async () => {
    const ctx = makeContext(await sha256Hex("correct-token"));

    await expect(handleSysSetupAssist({
      setupToken: "wrong-token",
      lane: "quick",
      draft: draft(),
      messages: [],
    } as any, ctx)).rejects.toBeInstanceOf(SetupTokenError);

    expect(ctx.consumeSetupAssistAllowance).not.toHaveBeenCalled();
    expect(handleAiTextGenerateMock).not.toHaveBeenCalled();
  });

  it("uses the runtime-owned policy for setup assistance", async () => {
    const token = "A".repeat(43);
    const ctx = makeContext("invalid-legacy-secret", "invalid", {
      version: 4,
      hash: await sha256Hex(token),
      expiresAt: 2_000_000_000_000,
    });
    handleAiTextGenerateMock.mockResolvedValue({
      message: assistantMessage(),
      text: JSON.stringify({ message: "Ready", reviewReady: false, patches: [] }),
    });

    await expect(handleSysSetupAssist({
      setupToken: token,
      lane: "quick",
      draft: draft(),
      messages: [],
    }, ctx)).resolves.toMatchObject({ message: "Ready" });
    expect(ctx.consumeSetupAssistAllowance).toHaveBeenCalledOnce();
  });

  it("rejects an expired managed setup token before spending inference or budget", async () => {
    const token = "expired-token";
    const ctx = makeContext(await sha256Hex(token), "1");

    await expect(handleSysSetupAssist({
      setupToken: token,
      lane: "quick",
      draft: draft(),
      messages: [],
    } as any, ctx)).rejects.toBeInstanceOf(SetupTokenError);

    expect(ctx.consumeSetupAssistAllowance).not.toHaveBeenCalled();
    expect(handleAiTextGenerateMock).not.toHaveBeenCalled();
  });

  it("rejects oversized prompts before spending inference or budget", async () => {
    const ctx = makeContext();
    await expect(handleSysSetupAssist({
      lane: "quick",
      draft: draft(),
      messages: [{ role: "user", content: "x".repeat(4 * 1024 + 1) }],
    }, ctx)).rejects.toThrow("Invalid setup assistance request");

    expect(ctx.consumeSetupAssistAllowance).not.toHaveBeenCalled();
    expect(handleAiTextGenerateMock).not.toHaveBeenCalled();
  });

  it("rejects a credential-bearing draft source before spending inference or budget", async () => {
    const ctx = makeContext();
    const unsafeDraft = {
      ...draft(),
      source: {
        enabled: true,
        value: "https://bootstrap-token@git.example.com/team/gsv.git",
        ref: "main",
      },
    };

    await expect(handleSysSetupAssist({
      lane: "quick",
      draft: unsafeDraft,
      messages: [],
    }, ctx)).rejects.toThrow("Bootstrap repository URLs must not include credentials");

    expect(ctx.consumeSetupAssistAllowance).not.toHaveBeenCalled();
    expect(handleAiTextGenerateMock).not.toHaveBeenCalled();
  });

  it("rejects credential-bearing repository URLs in guided messages before inference", async () => {
    const ctx = makeContext();

    await expect(handleSysSetupAssist({
      lane: "quick",
      draft: draft(),
      messages: [{
        role: "user",
        content: "Use https://git.example.com/team/gsv.git?token=super-secret please",
      }],
    }, ctx)).rejects.toThrow("Bootstrap repository URLs must not include credentials");

    expect(ctx.consumeSetupAssistAllowance).not.toHaveBeenCalled();
    expect(handleAiTextGenerateMock).not.toHaveBeenCalled();
  });

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
      lane: "quick",
      draft: draft(),
      messages: [],
    } as any, makeContext())).rejects.toThrow("insufficient funds");
  });
});
