import { describe, expect, it, vi } from "vitest";
import { bodyFromBytes, bodyToBytes } from "@humansandmachines/gsv/protocol";
import type { KernelContext } from "./context";

import * as ai from "./ai";
const imageGenerateMock = vi.spyOn(ai, "handleAiImageGenerate");
const imageReadMock = vi.spyOn(ai, "handleAiImageRead");
const speechCreateMock = vi.spyOn(ai, "handleAiSpeechCreate");
const transcriptionCreateMock = vi.spyOn(ai, "handleAiTranscriptionCreate");

import { dispatch, type DispatchDeps } from "./dispatch";
import type { RequestFrame } from "../protocol/frames";

// SAFETY: test fixture is constructed with the asserted kernel domain shape.
const ctx = {} as KernelContext;
// SAFETY: test fixture is constructed with the asserted kernel domain shape.
const deps = {} as DispatchDeps;
// SAFETY: test fixture is constructed with the asserted kernel domain shape.
const origin = { type: "connection", id: "test" } as const;

describe("media syscall dispatch", () => {
  it("passes transcription and image input bodies to their handlers", async () => {
    transcriptionCreateMock.mockResolvedValueOnce({ text: "hello" });
    imageReadMock.mockResolvedValueOnce({
      data: {
        mode: "caption",
        text: "a terminal",
        caption: "a terminal",
        captionLength: "normal",
        provider: "workers-ai",
        model: "moondream",
      },
    });
    const audioBody = bodyFromBytes(new Uint8Array([1, 2, 3]));
    const imageBody = bodyFromBytes(new Uint8Array([4, 5, 6]));

    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    await dispatch({
      type: "req",
      id: "transcription",
      call: "ai.transcription.create",
      args: { audio: { mimeType: "audio/webm" } },
      body: audioBody,
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as RequestFrame, origin, ctx, deps);
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    await dispatch({
      type: "req",
      id: "image-read",
      call: "ai.image.read",
      args: { image: { mimeType: "image/png" } },
      body: imageBody,
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as RequestFrame, origin, ctx, deps);

    expect(transcriptionCreateMock).toHaveBeenCalledWith(
      { audio: { mimeType: "audio/webm" } },
      { ...ctx, requestId: "transcription" },
      audioBody,
    );
    expect(imageReadMock).toHaveBeenCalledWith(
      { image: { mimeType: "image/png" } },
      { ...ctx, requestId: "image-read" },
      imageBody,
    );
  });

  it("moves generated image and speech bytes out of JSON", async () => {
    imageGenerateMock.mockResolvedValueOnce({
      data: {
        image: { mimeType: "image/png", size: 3 },
        provider: "test",
        model: "test-image",
      },
      body: bodyFromBytes(new Uint8Array([1, 2, 3])),
    });
    speechCreateMock.mockResolvedValueOnce({
      data: {
        audio: { mimeType: "audio/mpeg", size: 3 },
        provider: "test",
        model: "test-speech",
        skipped: false,
      },
      body: bodyFromBytes(new Uint8Array([4, 5, 6])),
    });

    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const image = await dispatch({
      type: "req",
      id: "image-generate",
      call: "ai.image.generate",
      args: { prompt: "test" },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as RequestFrame, origin, ctx, deps);
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const speech = await dispatch({
      type: "req",
      id: "speech-create",
      call: "ai.speech.create",
      args: { text: "test" },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as RequestFrame, origin, ctx, deps);

    expect(image.response).toMatchObject({
      ok: true,
      data: { image: { mimeType: "image/png", size: 3 } },
    });
    expect(speech.response).toMatchObject({
      ok: true,
      data: { audio: { mimeType: "audio/mpeg", size: 3 } },
    });
    if (!image.response.ok || !speech.response.ok) {
      throw new Error("Expected successful media responses");
    }
    expect(image.response.data).not.toHaveProperty("image.data");
    expect(speech.response.data).not.toHaveProperty("audio.data");
    expect(image.response.body && [...await bodyToBytes(image.response.body)]).toEqual([1, 2, 3]);
    expect(speech.response.body && [...await bodyToBytes(speech.response.body)]).toEqual([4, 5, 6]);
  });

  // SAFETY: test fixture is constructed with the asserted kernel domain shape.
  it("forwards streamed image-reading text as a response body", async () => {
    imageReadMock.mockResolvedValueOnce({
      data: {
        mode: "caption",
        streamed: true,
        contentType: "text/plain; charset=utf-8",
        provider: "workers-ai",
        model: "moondream",
      },
      body: bodyFromBytes(new TextEncoder().encode("streamed caption")),
    });

    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const result = await dispatch({
      type: "req",
      id: "image-read-stream",
      call: "ai.image.read",
      args: {
        image: { mimeType: "image/png" },
        mode: "caption",
        stream: true,
      },
      body: bodyFromBytes(new Uint8Array([1, 2, 3])),
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as RequestFrame, origin, ctx, deps);

    expect(result.response).toMatchObject({
      ok: true,
      data: {
        mode: "caption",
        streamed: true,
      },
    });
    if (!result.response.ok || !result.response.body) {
      throw new Error("Expected streamed image-reading body");
    }
    expect(new TextDecoder().decode(await bodyToBytes(result.response.body)))
      .toBe("streamed caption");
  });
});
