import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";

vi.mock("@earendil-works/pi-ai", async () => {
  const actual = await vi.importActual<typeof import("@earendil-works/pi-ai")>("@earendil-works/pi-ai");
  return {
    ...actual,
    completeSimple: vi.fn(async () => ({
      role: "assistant",
      content: [{ type: "text", text: "pi-ai image description" }],
      api: "test",
      provider: "openai",
      model: "gpt-4o",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 0,
    })),
    getProviders: vi.fn(() => ["openai"]),
    getModels: vi.fn((provider: string) => provider === "openai"
      ? [{ id: "gpt-4o", provider: "openai", api: "openai-responses" }]
      : []),
  };
});

import {
  completeSimple,
  getModels,
  getProviders,
} from "@earendil-works/pi-ai";
import {
  DEFAULT_AUDIO_TRANSCRIPTION_MODEL,
  DEFAULT_IMAGE_READING_MODEL,
  deleteProcessMedia,
  parseStoredProcessMedia,
  storeIncomingProcessMedia,
  type AudioTranscriptionBinding,
  type ImageReadingBinding,
} from "./media";

const touchedPids = new Set<string>();

function pidForTest(name: string): string {
  const pid = `media-test-${name}-${crypto.randomUUID()}`;
  touchedPids.add(pid);
  return pid;
}

afterEach(async () => {
  for (const pid of touchedPids) {
    await deleteProcessMedia(env.STORAGE, 0, pid);
  }
  touchedPids.clear();
  vi.clearAllMocks();
});

describe("process media", () => {
  it("transcribes incoming audio with Workers AI before storing metadata", async () => {
    const ai: AudioTranscriptionBinding = {
      run: vi.fn(async () => ({
        text: "voice note transcript",
        transcription_info: { duration: 1.5 },
      })),
    };

    const raw = await storeIncomingProcessMedia(
      env.STORAGE,
      0,
      pidForTest("transcribe"),
      [
        {
          type: "audio",
          mimeType: "audio/ogg",
          data: "AQID",
          filename: "voice.ogg",
        },
      ],
      { ai },
    );

    const media = parseStoredProcessMedia(raw);
    expect(media).toHaveLength(1);
    expect(media[0].transcription).toBe("voice note transcript");
    expect(media[0].duration).toBe(1.5);
    expect(media[0].key).toBeTruthy();
    expect(ai.run).toHaveBeenCalledWith(
      DEFAULT_AUDIO_TRANSCRIPTION_MODEL,
      expect.objectContaining({
        audio: "AQID",
        task: "transcribe",
        vad_filter: true,
      }),
    );
  });

  it("keeps audio media when transcription fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ai: AudioTranscriptionBinding = {
      run: vi.fn(async () => {
        throw new Error("stt unavailable");
      }),
    };

    const raw = await storeIncomingProcessMedia(
      env.STORAGE,
      0,
      pidForTest("transcribe-fail"),
      [
        {
          type: "audio",
          mimeType: "audio/ogg",
          data: "AQID",
          filename: "voice.ogg",
        },
      ],
      { ai },
    );

    const media = parseStoredProcessMedia(raw);
    expect(media).toHaveLength(1);
    expect(media[0].type).toBe("audio");
    expect(media[0].transcription).toBeUndefined();
    expect(media[0].key).toBeTruthy();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("does not retranscribe audio that already has a transcript", async () => {
    const ai: AudioTranscriptionBinding = {
      run: vi.fn(async () => ({ text: "ignored" })),
    };

    const raw = await storeIncomingProcessMedia(
      env.STORAGE,
      0,
      pidForTest("existing-transcript"),
      [
        {
          type: "audio",
          mimeType: "audio/ogg",
          data: "AQID",
          filename: "voice.ogg",
          transcription: "existing transcript",
        },
      ],
      { ai },
    );

    const media = parseStoredProcessMedia(raw);
    expect(media[0].transcription).toBe("existing transcript");
    expect(ai.run).not.toHaveBeenCalled();
  });

  it("describes incoming images with the configured image reader", async () => {
    const ai: ImageReadingBinding = {
      run: vi.fn(async () => ({
        description: "a screenshot of a settings page",
      })),
    };

    const raw = await storeIncomingProcessMedia(
      env.STORAGE,
      0,
      pidForTest("image-read"),
      [
        {
          type: "image",
          mimeType: "image/png",
          data: "AQID",
          filename: "settings.png",
        },
      ],
      {
        ai: ai as AudioTranscriptionBinding & ImageReadingBinding,
        imageReadingModel: "@cf/custom/vision",
        imageReadingPrompt: "Describe the UI.",
        imageReadingMaxTokens: 128,
      },
    );

    const media = parseStoredProcessMedia(raw);
    expect(media).toHaveLength(1);
    expect(media[0].description).toBe("a screenshot of a settings page");
    expect(media[0].key).toBeTruthy();
    expect(ai.run).toHaveBeenCalledWith(
      "@cf/custom/vision",
      expect.objectContaining({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Describe the UI." },
              {
                type: "image_url",
                image_url: {
                  url: "data:image/png;base64,AQID",
                  detail: "auto",
                },
              },
            ],
          },
        ],
        max_completion_tokens: 128,
      }),
    );
  });

  it("supports legacy raw image Workers AI models", async () => {
    const ai: ImageReadingBinding = {
      run: vi.fn(async () => ({
        description: "a legacy image model description",
      })),
    };

    const raw = await storeIncomingProcessMedia(
      env.STORAGE,
      0,
      pidForTest("image-read-legacy"),
      [
        {
          type: "image",
          mimeType: "image/png",
          data: "AQID",
          filename: "settings.png",
        },
      ],
      {
        ai: ai as AudioTranscriptionBinding & ImageReadingBinding,
        imageReadingModel: "@cf/llava-hf/llava-1.5-7b-hf",
        imageReadingInputFormat: "auto",
        imageReadingPrompt: "Describe the UI.",
        imageReadingMaxTokens: 128,
      },
    );

    const media = parseStoredProcessMedia(raw);
    expect(media[0].description).toBe("a legacy image model description");
    expect(ai.run).toHaveBeenCalledWith(
      "@cf/llava-hf/llava-1.5-7b-hf",
      expect.objectContaining({
        image: [1, 2, 3],
        prompt: "Describe the UI.",
        max_tokens: 128,
      }),
    );
  });

  it("routes non-Workers image readers through pi-ai providers", async () => {
    const raw = await storeIncomingProcessMedia(
      env.STORAGE,
      0,
      pidForTest("image-read-piai"),
      [
        {
          type: "image",
          mimeType: "image/png",
          data: "AQID",
          filename: "settings.png",
        },
      ],
      {
        imageReadingProvider: "openai",
        imageReadingModel: "gpt-4o",
        imageReadingApiKey: "reader-key",
        imageReadingPrompt: "Describe the UI.",
        imageReadingMaxTokens: 128,
      },
    );

    const media = parseStoredProcessMedia(raw);
    expect(media[0].description).toBe("pi-ai image description");
    expect(getProviders).toHaveBeenCalled();
    expect(getModels).toHaveBeenCalledWith("openai");
    expect(completeSimple).toHaveBeenCalledWith(
      expect.objectContaining({ id: "gpt-4o" }),
      {
        messages: [
          {
            role: "user",
            timestamp: expect.any(Number),
            content: [
              { type: "text", text: "Describe the UI." },
              { type: "image", data: "AQID", mimeType: "image/png" },
            ],
          },
        ],
      },
      expect.objectContaining({
        apiKey: "reader-key",
        maxTokens: 128,
        timeoutMs: 30000,
      }),
    );
  });

  it("keeps image media when image reading fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ai: ImageReadingBinding = {
      run: vi.fn(async () => {
        throw new Error("vision unavailable");
      }),
    };

    const raw = await storeIncomingProcessMedia(
      env.STORAGE,
      0,
      pidForTest("image-read-fail"),
      [
        {
          type: "image",
          mimeType: "image/png",
          data: "AQID",
          filename: "settings.png",
        },
      ],
      { ai: ai as AudioTranscriptionBinding & ImageReadingBinding },
    );

    const media = parseStoredProcessMedia(raw);
    expect(media).toHaveLength(1);
    expect(media[0].type).toBe("image");
    expect(media[0].description).toBeUndefined();
    expect(media[0].key).toBeTruthy();
    expect(ai.run).toHaveBeenCalledWith(DEFAULT_IMAGE_READING_MODEL, expect.any(Object));
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
