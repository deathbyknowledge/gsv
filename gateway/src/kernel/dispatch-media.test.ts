import { describe, expect, it, vi } from "vitest";
import { bodyFromBytes, bodyToBytes } from "@humansandmachines/gsv/protocol";
import type { KernelContext } from "./context";

const {
  imageGenerateMock,
  imageReadMock,
  speechCreateMock,
  transcriptionCreateMock,
} = vi.hoisted(() => ({
  imageGenerateMock: vi.fn(),
  imageReadMock: vi.fn(),
  speechCreateMock: vi.fn(),
  transcriptionCreateMock: vi.fn(),
}));

vi.mock("./ai", async (importOriginal) => ({
  ...await importOriginal<typeof import("./ai")>(),
  handleAiImageGenerate: imageGenerateMock,
  handleAiImageRead: imageReadMock,
  handleAiSpeechCreate: speechCreateMock,
  handleAiTranscriptionCreate: transcriptionCreateMock,
}));

import { dispatch, type DispatchDeps } from "./dispatch";
import type { RequestFrame } from "../protocol/frames";

const ctx = {} as KernelContext;
const deps = {} as DispatchDeps;
const origin = { type: "connection", id: "test" } as const;

describe("media syscall dispatch", () => {
  it("passes transcription and image input bodies to their handlers", async () => {
    transcriptionCreateMock.mockResolvedValueOnce({ text: "hello" });
    imageReadMock.mockResolvedValueOnce({ text: "a terminal" });
    const audioBody = bodyFromBytes(new Uint8Array([1, 2, 3]));
    const imageBody = bodyFromBytes(new Uint8Array([4, 5, 6]));

    await dispatch({
      type: "req",
      id: "transcription",
      call: "ai.transcription.create",
      args: { audio: { mimeType: "audio/webm" } },
      body: audioBody,
    } as RequestFrame, origin, ctx, deps);
    await dispatch({
      type: "req",
      id: "image-read",
      call: "ai.image.read",
      args: { image: { mimeType: "image/png" } },
      body: imageBody,
    } as RequestFrame, origin, ctx, deps);

    expect(transcriptionCreateMock).toHaveBeenCalledWith(
      { audio: { mimeType: "audio/webm" } },
      ctx,
      audioBody,
    );
    expect(imageReadMock).toHaveBeenCalledWith(
      { image: { mimeType: "image/png" } },
      ctx,
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

    const image = await dispatch({
      type: "req",
      id: "image-generate",
      call: "ai.image.generate",
      args: { prompt: "test" },
    } as RequestFrame, origin, ctx, deps);
    const speech = await dispatch({
      type: "req",
      id: "speech-create",
      call: "ai.speech.create",
      args: { text: "test" },
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
});
