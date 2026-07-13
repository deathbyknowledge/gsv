import type { GSVClient, GsvBody } from "@humansandmachines/gsv/client";
import { describe, expect, it, vi } from "vitest";
import { frameBodyFromBlob } from "./frameBody";
import { requestAudioTranscription, requestSpeechAudio } from "./mediaRequests";

type MediaRequestClient = Pick<GSVClient, "request">;

describe("gateway media requests", () => {
  it("sends transcription audio as a frame body with metadata-only args", async () => {
    const request = vi.fn(async (..._args: unknown[]) => ({
      data: {
        text: "hello",
        provider: "workers-ai",
        model: "whisper",
      },
    }));
    const audio = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" });
    const controller = new AbortController();

    const result = await requestAudioTranscription({ request } as unknown as MediaRequestClient, {
      audio: {
        mimeType: "audio/webm",
        filename: "voice.webm",
      },
    }, audio, controller.signal);

    expect(result.text).toBe("hello");
    expect(request).toHaveBeenCalledWith(
      "ai.transcription.create",
      {
        audio: {
          mimeType: "audio/webm",
          filename: "voice.webm",
        },
      },
      {
        body: expect.objectContaining({ length: 3 }),
        signal: controller.signal,
      },
    );
    const options = request.mock.calls[0]?.[2] as { body?: GsvBody } | undefined;
    const body = options?.body;
    expect(body).toBeDefined();
    expect(Array.from(new Uint8Array(await new Response(body!.stream).arrayBuffer()))).toEqual([1, 2, 3]);
  });

  it("reads synthesized speech from the response body", async () => {
    const request = vi.fn(async () => ({
      data: {
        audio: { mimeType: "audio/mpeg", size: 3 },
        provider: "workers-ai",
        model: "aura",
      },
      body: frameBodyFromBlob(new Blob([new Uint8Array([7, 8, 9])])),
    }));

    const response = await requestSpeechAudio({ request } as unknown as MediaRequestClient, {
      text: "hello",
    });

    expect(request).toHaveBeenCalledWith("ai.speech.create", { text: "hello" });
    expect(response.result.provider).toBe("workers-ai");
    expect(response.audio?.type).toBe("audio/mpeg");
    expect(Array.from(new Uint8Array(await response.audio!.arrayBuffer()))).toEqual([7, 8, 9]);
  });

  it("does not require a body for skipped speech", async () => {
    const request = vi.fn(async () => ({
      data: {
        audio: { mimeType: "", size: 0 },
        provider: "none",
        model: "none",
        skipped: true,
      },
    }));

    const response = await requestSpeechAudio({ request } as unknown as MediaRequestClient, {
      text: "```",
    });

    expect(response.result.skipped).toBe(true);
    expect(response.audio).toBeNull();
  });
});
