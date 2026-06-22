import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_IMAGE_GENERATION_MODEL,
  DEFAULT_OPENAI_IMAGE_MODEL,
  DEFAULT_OPENAI_SPEECH_MODEL,
  DEFAULT_OPENAI_SPEECH_VOICE,
  DEFAULT_OPENAI_TRANSCRIPTION_MODEL,
  generateImage,
  synthesizeSpeech,
  transcribeAudio,
  type CapabilityFetch,
} from "./capabilities";

describe("AI media capability adapters", () => {
  it("routes OpenAI transcription through the audio transcription REST API", async () => {
    const fetchFn: CapabilityFetch = vi.fn(async () =>
      Response.json({
        text: "meeting notes",
        duration: 2.5,
        language: "en",
      })
    );

    const result = await transcribeAudio({ fetch: fetchFn }, {
      provider: "openai",
      apiKey: "openai-key",
      data: "data:audio/webm;base64,AQID",
      mimeType: "audio/webm",
      filename: "note.webm",
    });

    expect(result).toMatchObject({
      provider: "openai",
      model: DEFAULT_OPENAI_TRANSCRIPTION_MODEL,
      text: "meeting notes",
      duration: 2.5,
      language: "en",
    });
    expect(fetchFn).toHaveBeenCalledWith(
      "https://api.openai.com/v1/audio/transcriptions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer openai-key",
        }),
        body: expect.any(FormData),
      }),
    );
  });

  it("routes OpenAI speech through the audio speech REST API", async () => {
    const fetchFn: CapabilityFetch = vi.fn(async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "audio/mpeg" },
      })
    );

    const result = await synthesizeSpeech({ fetch: fetchFn }, {
      provider: "openai",
      apiKey: "openai-key",
      text: "Hello",
    });

    expect(result).toMatchObject({
      provider: "openai",
      model: DEFAULT_OPENAI_SPEECH_MODEL,
      voice: DEFAULT_OPENAI_SPEECH_VOICE,
      encoding: "mp3",
      data: "data:audio/mpeg;base64,AQID",
      mimeType: "audio/mpeg",
      size: 3,
    });
    const init = vi.mocked(fetchFn).mock.calls[0][1]!;
    expect(fetchFn).toHaveBeenCalledWith(
      "https://api.openai.com/v1/audio/speech",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer openai-key",
          "Content-Type": "application/json",
        }),
      }),
    );
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: DEFAULT_OPENAI_SPEECH_MODEL,
      input: "Hello",
      voice: DEFAULT_OPENAI_SPEECH_VOICE,
      response_format: "mp3",
    });
  });

  it("routes Workers AI image generation through the binding", async () => {
    const workersAi = {
      run: vi.fn(async () => ({ image: "AQID", mime_type: "image/png" })),
    };

    const result = await generateImage({ workersAi }, {
      provider: "workers-ai",
      prompt: "a quiet desktop tool screenshot",
    });

    expect(result).toMatchObject({
      provider: "workers-ai",
      model: DEFAULT_IMAGE_GENERATION_MODEL,
      data: "data:image/png;base64,AQID",
      mimeType: "image/png",
      size: 3,
    });
    expect(workersAi.run).toHaveBeenCalledWith(
      DEFAULT_IMAGE_GENERATION_MODEL,
      { prompt: "a quiet desktop tool screenshot" },
    );
  });

  it("routes OpenAI image generation through the images REST API", async () => {
    const fetchFn: CapabilityFetch = vi.fn(async () =>
      Response.json({
        data: [{
          b64_json: "AQID",
          revised_prompt: "a quiet desktop tool screenshot",
        }],
      })
    );

    const result = await generateImage({ fetch: fetchFn }, {
      provider: "openai",
      apiKey: "openai-key",
      prompt: "desktop tool",
      format: "webp",
    });

    expect(result).toMatchObject({
      provider: "openai",
      model: DEFAULT_OPENAI_IMAGE_MODEL,
      data: "data:image/webp;base64,AQID",
      mimeType: "image/webp",
      size: 3,
      revisedPrompt: "a quiet desktop tool screenshot",
    });
    const init = vi.mocked(fetchFn).mock.calls[0][1]!;
    expect(fetchFn).toHaveBeenCalledWith(
      "https://api.openai.com/v1/images/generations",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer openai-key",
          "Content-Type": "application/json",
        }),
      }),
    );
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: DEFAULT_OPENAI_IMAGE_MODEL,
      prompt: "desktop tool",
      n: 1,
      output_format: "webp",
    });
  });
});
