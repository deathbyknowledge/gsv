import { afterEach, describe, expect, it, vi } from "vitest";
import {
  synthesizeSpeech,
  type AudioSpeechBinding,
} from "../../src/media";

afterEach(() => vi.useRealTimers());

describe("Workers AI speech execution", () => {
  it("preserves MeloTTS prompt and language without a speaker", async () => {
    const run = vi.fn<AudioSpeechBinding["run"]>(async () => ({ audio: "AQID" }));
    const result = await synthesizeSpeech({ workersAi: { run } }, {
      provider: "workers-ai",
      model: "@cf/myshell-ai/melotts",
      text: "Hello",
      language: "nl",
      voice: "unused-voice",
    });

    expect(run).toHaveBeenCalledExactlyOnceWith("@cf/myshell-ai/melotts", {
      prompt: "Hello",
      lang: "nl",
    });
    expect(result).toEqual({
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "audio/mpeg",
      provider: "workers-ai",
      model: "@cf/myshell-ai/melotts",
      encoding: "mp3",
    });
  });

  it("preserves explicit speaker, container and sampling settings", async () => {
    const run = vi.fn<AudioSpeechBinding["run"]>(async () => new Uint8Array([4, 5, 6]));
    const result = await synthesizeSpeech({ workersAi: { run } }, {
      provider: "workersai",
      model: "@cf/deepgram/aura-2-en",
      text: "Hello",
      voice: "luna",
      encoding: "linear16",
      container: "wav",
      sampleRate: 24_000,
      bitRate: 64_000,
    });

    expect(run).toHaveBeenCalledExactlyOnceWith("@cf/deepgram/aura-2-en", {
      text: "Hello",
      speaker: "luna",
      encoding: "linear16",
      container: "wav",
      sample_rate: 24_000,
      bit_rate: 64_000,
    });
    expect(result).toMatchObject({
      bytes: new Uint8Array([4, 5, 6]),
      mimeType: "audio/wav",
      voice: "luna",
      encoding: "linear16",
      container: "wav",
    });
  });

  it("retains provider response MIME metadata when consuming audio", async () => {
    const run = vi.fn<AudioSpeechBinding["run"]>(async () => new Response(
      new Uint8Array([7, 8, 9]),
      { headers: { "content-type": "audio/ogg" } },
    ));
    const result = await synthesizeSpeech({ workersAi: { run } }, {
      provider: "workers-ai",
      model: "@cf/deepgram/aura-2-en",
      text: "Hello",
    });

    expect(result?.mimeType).toBe("audio/ogg");
    expect(result?.bytes).toEqual(new Uint8Array([7, 8, 9]));
  });

  it("retains the speech generation timeout for a stalled binding", async () => {
    vi.useFakeTimers();
    const run = vi.fn<AudioSpeechBinding["run"]>(() => new Promise(() => {}));
    const result = synthesizeSpeech({ workersAi: { run } }, {
      provider: "workers-ai",
      model: "@cf/deepgram/aura-2-en",
      text: "Hello",
      timeoutMs: 25,
    });
    const rejected = expect(result).rejects.toThrow("Speech synthesis timed out after 25ms");
    await vi.advanceTimersByTimeAsync(25);
    await rejected;
  });
});
