import { describe, expect, it, vi } from "vitest";
import {
  OpenAiCodexLoginCancelledError,
  runOpenAiCodexLoginFlow,
  type OpenAiCodexOAuthStart,
} from "./useOpenAiCodexLogin";

describe("OpenAI Codex login flow", () => {
  const started: OpenAiCodexOAuthStart = {
    flowId: "flow-1",
    userCode: "ABCD-EFGH",
    verificationUrl: "https://auth.openai.com/codex/device",
    intervalSeconds: 5,
    expiresAt: 20_000,
  };

  it("polls until the device flow completes", async () => {
    const onPoll = vi.fn()
      .mockResolvedValueOnce({ status: "pending", intervalSeconds: 10, expiresAt: 30_000 })
      .mockResolvedValueOnce({ status: "complete" });
    const waits: number[] = [];
    const onUpdated = vi.fn();

    await runOpenAiCodexLoginFlow({
      signal: new AbortController().signal,
      onPoll,
      onStart: async () => started,
      onStarted: vi.fn(),
      onUpdated,
      now: () => 0,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      },
    });

    expect(waits).toEqual([5_000, 10_000]);
    expect(onPoll).toHaveBeenCalledTimes(2);
    expect(onUpdated).toHaveBeenCalledWith({
      ...started,
      intervalSeconds: 10,
      expiresAt: 30_000,
    });
  });

  it("stops a superseded attempt before it can poll or update state", async () => {
    const attempt = new AbortController();
    const onPoll = vi.fn();
    const onUpdated = vi.fn();

    await expect(runOpenAiCodexLoginFlow({
      signal: attempt.signal,
      onPoll,
      onStart: async () => started,
      onStarted: () => attempt.abort(),
      onUpdated,
      now: () => 0,
      wait: async (_milliseconds, signal) => {
        if (signal.aborted) {
          throw new OpenAiCodexLoginCancelledError();
        }
      },
    })).rejects.toBeInstanceOf(OpenAiCodexLoginCancelledError);

    expect(onPoll).not.toHaveBeenCalled();
    expect(onUpdated).not.toHaveBeenCalled();
  });
});
