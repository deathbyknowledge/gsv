import { afterEach, describe, expect, it, vi } from "vitest";
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

afterEach(() => {
  vi.useRealTimers();
});

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

  it("propagates transcription cancellation to OpenAI fetch", async () => {
    const controller = new AbortController();
    let fetchSignal: AbortSignal | null | undefined;
    const fetchFn: CapabilityFetch = vi.fn((_url, init) => {
      fetchSignal = init?.signal;
      return new Promise<never>(() => {});
    });

    const request = transcribeAudio({ fetch: fetchFn }, {
      provider: "openai",
      apiKey: "openai-key",
      data: "AQID",
      mimeType: "audio/webm",
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort(new Error("caller cancelled"));

    await expect(request).rejects.toThrow("caller cancelled");
    expect(fetchSignal).toBeDefined();
    expect(fetchSignal).not.toBe(controller.signal);
    expect(fetchSignal?.aborted).toBe(true);
  });

  it("keeps the OpenAI timeout active while reading the response", async () => {
    vi.useFakeTimers();
    const fetchFn: CapabilityFetch = vi.fn(async () =>
      new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"text":"partial'));
        },
      }), {
        headers: { "content-type": "application/json" },
      })
    );

    const request = transcribeAudio({ fetch: fetchFn }, {
      provider: "openai",
      apiKey: "openai-key",
      data: "AQID",
      mimeType: "audio/webm",
      timeoutMs: 25,
    });
    const rejection = expect(request).rejects.toThrow(
      "OpenAI audio transcription timed out after 25ms",
    );
    await vi.advanceTimersByTimeAsync(25);

    await rejection;
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
      mimeType: "audio/mpeg",
    });
    expect([...result!.bytes]).toEqual([1, 2, 3]);
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
      run: vi.fn(async () => ({ image: "/9j/4AAQSkZJRgABAQAAAQABAAD/2Q==" })),
    };

    const result = await generateImage({ workersAi }, {
      provider: "workers-ai",
      prompt: "a quiet desktop tool screenshot",
    });

    expect(result).toMatchObject({
      provider: "workers-ai",
      model: DEFAULT_IMAGE_GENERATION_MODEL,
      mimeType: "image/jpeg",
    });
    expect([...result!.bytes!.subarray(0, 4)]).toEqual([0xff, 0xd8, 0xff, 0xe0]);
    expect(workersAi.run).toHaveBeenCalledWith(
      DEFAULT_IMAGE_GENERATION_MODEL,
      { prompt: "a quiet desktop tool screenshot" },
    );
  });

  it.each([
    ["@cf/custom/image", "iVBORw0KGgo=", "image/png"],
    ["@cf/custom/image", "R0lGODlh", "image/gif"],
  ])("sniffs Workers AI base64 output from %s", async (model, image, mimeType) => {
    const result = await generateImage({
      workersAi: { run: vi.fn(async () => ({ image })) },
    }, {
      provider: "workers-ai",
      model,
      prompt: "a generated image",
    });

    expect(result?.mimeType).toBe(mimeType);
  });

  it.each([
    ["@cf/leonardo/phoenix-1.0", [0xff, 0xd8, 0xff, 0xe0], "image/jpeg"],
    [
      "@cf/custom/image",
      [0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50],
      "image/webp",
    ],
  ])("sniffs Workers AI stream output from %s", async (model, data, mimeType) => {
    const bytes = new Uint8Array(data);
    const result = await generateImage({
      workersAi: {
        run: vi.fn(async () => new ReadableStream({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        })),
      },
    }, {
      provider: "workers-ai",
      model,
      prompt: "a generated image",
    });

    expect(result?.mimeType).toBe(mimeType);
    expect(result?.bytes).toEqual(bytes);
  });

  it("prefers explicit image MIME from provider fields, data URLs, and headers", async () => {
    const jpeg = "/9j/4AAQSkZJRgABAQAAAQABAAD/2Q==";
    const responses = [
      { value: { image: jpeg, mime_type: "Image/PNG; charset=binary" }, mimeType: "image/png" },
      { value: `data:image/gif;base64,${jpeg}`, mimeType: "image/gif" },
      {
        value: new Response(Uint8Array.from(atob(jpeg), (char) => char.charCodeAt(0)), {
          headers: { "content-type": "image/png" },
        }),
        mimeType: "image/png",
      },
    ];

    for (const testCase of responses) {
      const result = await generateImage({
        workersAi: { run: vi.fn(async () => testCase.value) },
      }, {
        provider: "workers-ai",
        prompt: "a generated image",
      });
      expect(result?.mimeType).toBe(testCase.mimeType);
    }
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
      mimeType: "image/webp",
      revisedPrompt: "a quiet desktop tool screenshot",
    });
    expect([...result!.bytes!]).toEqual([1, 2, 3]);
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
