import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_AUDIO_TRANSCRIPTION_TIMEOUT_MS,
  transcribeAudioWithWorkersAi,
} from "./transcription";

afterEach(() => {
  vi.useRealTimers();
});

describe("Workers AI transcription", () => {
  it("propagates caller cancellation to the binding", async () => {
    const controller = new AbortController();
    let bindingSignal: AbortSignal | undefined;
    const run = vi.fn((_model: string, _input: unknown, options?: { signal?: AbortSignal }) => {
      bindingSignal = options?.signal;
      return new Promise<never>(() => {});
    });

    const request = transcribeAudioWithWorkersAi({ run }, {
      data: "AQID",
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort(new Error("caller cancelled"));

    await expect(request).rejects.toThrow("caller cancelled");
    expect(bindingSignal).toBeDefined();
    expect(bindingSignal).toBe(controller.signal);
    expect(bindingSignal?.aborted).toBe(true);
  });

  it("aborts a transcription that exceeds its bounded timeout", async () => {
    vi.useFakeTimers();
    let bindingSignal: AbortSignal | undefined;
    const run = vi.fn((_model: string, _input: unknown, options?: { signal?: AbortSignal }) => {
      bindingSignal = options?.signal;
      return new Promise<never>(() => {});
    });

    const request = transcribeAudioWithWorkersAi({ run }, {
      data: "AQID",
      timeoutMs: DEFAULT_AUDIO_TRANSCRIPTION_TIMEOUT_MS,
    });
    const rejection = expect(request).rejects.toThrow(
      `Transcription timed out after ${DEFAULT_AUDIO_TRANSCRIPTION_TIMEOUT_MS}ms`,
    );
    await vi.advanceTimersByTimeAsync(DEFAULT_AUDIO_TRANSCRIPTION_TIMEOUT_MS);

    await rejection;
    expect(bindingSignal?.aborted).toBe(true);
  });
});
