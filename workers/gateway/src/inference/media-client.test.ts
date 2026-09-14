import { afterEach, describe, expect, it, vi } from "vitest";
import type { InferenceMediaResult } from "@humansandmachines/gsv/services/inference-execution";
import type { GatewayEnv } from "../runtime-env";
import { createMediaExecutor } from "./media-client";

const identity = { installationId: "space-a", logicalRequestId: "media-a", actor: { localUid: 1000 } };
function fixture() {
  const target = { media: vi.fn<(...args: unknown[]) => Promise<InferenceMediaResult>>(), abort: vi.fn(async () => {}), [Symbol.dispose]: vi.fn() };
  const getExecutor = vi.fn(async () => target);
  // SAFETY: This fixture supplies the only binding used by the media RPC client.
  const env = { INFERENCE_EXECUTION: { getExecutor } } as GatewayEnv;
  return { target, getExecutor, execute: createMediaExecutor(env, async () => identity) };
}
const operation = { kind: "speech" as const, input: { provider: "workers-ai", model: "speech-test", text: "hello", voice: "asteria", encoding: "mp3" } };
afterEach(() => vi.useRealTimers());

describe("gateway media execution ownership", () => {
  it("keeps the executor alive until the streamed result is consumed", async () => {
    const { target, getExecutor, execute } = fixture();
    target.media.mockResolvedValue({ kind: "speech", result: { mimeType: "audio/mpeg", model: "speech-test", size: 5, provider: "workers-ai" }, body: new Response("audio").body! });
    const result = await execute(operation, undefined, 1000);
    expect(getExecutor).toHaveBeenCalledWith("space-a");
    expect(target.media).toHaveBeenCalledWith(expect.objectContaining({ ...identity, ...operation, timeoutMs: 1000 }), undefined);
    expect(target[Symbol.dispose]).not.toHaveBeenCalled();
    if (!("body" in result)) throw new Error("missing media body");
    expect(await new Response(result.body).text()).toBe("audio");
    expect(target[Symbol.dispose]).toHaveBeenCalledOnce();
    expect(target.abort).not.toHaveBeenCalled();
  });

  it("enforces the deadline and releases an output nobody starts reading", async () => {
    vi.useFakeTimers();
    const { target, execute } = fixture();
    const cancel = vi.fn();
    target.media.mockResolvedValue({ kind: "speech", result: { mimeType: "audio/mpeg", model: "speech-test", size: 5, provider: "workers-ai" }, body: new ReadableStream({ cancel }) });
    const result = await execute(operation, undefined, 50);
    await vi.advanceTimersByTimeAsync(51);
    expect(target.abort).toHaveBeenCalledExactlyOnceWith("media-a", "timeout");
    expect(cancel).toHaveBeenCalledOnce();
    expect(target[Symbol.dispose]).toHaveBeenCalledOnce();
    if (!("body" in result)) throw new Error("missing media body");
    await expect(new Response(result.body).text()).rejects.toThrow("timed out");
  });

  it("cancels an input body when no inference service can accept ownership", async () => {
    const cancel = vi.fn();
    // SAFETY: Deliberately missing binding exercises admission cleanup.
    const execute = createMediaExecutor({} as GatewayEnv, async () => identity);
    await expect(execute({ kind: "transcription", input: { provider: "workers-ai", model: "whisper", maxInputBytes: 100 } }, new ReadableStream({ cancel }), 1000)).rejects.toThrow("not configured");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("settles an admission timeout even when input cancellation remains pending", async () => {
    vi.useFakeTimers();
    const { getExecutor, execute } = fixture();
    getExecutor.mockImplementation(() => new Promise<never>(() => {}));
    let finishCancellation!: () => void;
    const cancel = vi.fn(() => new Promise<void>((resolve) => { finishCancellation = resolve; }));
    const completed = vi.fn();
    const pending = execute({ kind: "transcription", input: { provider: "workers-ai", model: "whisper", maxInputBytes: 100 } }, new ReadableStream({ cancel }), 50).catch(completed);
    try {
      await vi.advanceTimersByTimeAsync(51);
      expect(cancel).toHaveBeenCalledOnce();
      expect(completed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: "TimeoutError" }));
    } finally {
      finishCancellation();
      await pending;
    }
  });
});
