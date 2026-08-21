import { describe, expect, it, vi } from "vitest";

import {
  binaryBodyFromOwnedBytes,
  readAdapterMediaBody,
} from "../../shared/src/media-body";
import {
  extractTelegramInboundContent,
  loadTelegramInboundMedia,
} from "./telegram-inbound-media";

describe("Telegram inbound media", () => {
  it("shares standalone and managed voice normalization", () => {
    expect(extractTelegramInboundContent({
      voice: {
        file_id: "voice_file_123",
        file_size: 4,
        duration: 2,
        mime_type: "audio/ogg",
      },
    }, "7")).toEqual({
      text: "[Voice note]",
      media: [{
        type: "audio",
        fileId: "voice_file_123",
        mimeType: "audio/ogg",
        filename: "telegram-voice-7.ogg",
        size: 4,
        duration: 2,
      }],
    });
  });

  it("packs downloaded attachments into one binary frame body", async () => {
    const content = extractTelegramInboundContent({
      caption: "look and listen",
      photo: [
        { file_id: "small", file_size: 2, width: 10, height: 10 },
        { file_id: "large", file_size: 3, width: 20, height: 20 },
      ],
      voice: { file_id: "voice", file_size: 2, duration: 1 },
    }, "9");
    const bytes = new Map([
      ["large", new Uint8Array([1, 2, 3])],
      ["voice", new Uint8Array([4, 5])],
    ]);
    const loaded = await loadTelegramInboundMedia(content.media, {
      getFile: async (fileId) => ({
        file_size: bytes.get(fileId)!.byteLength,
        file_path: fileId,
      }),
      downloadFile: async (filePath) => binaryBodyFromOwnedBytes(bytes.get(filePath)!),
    });

    expect(content.text).toBe("look and listen");
    expect(loaded.media.map((media) => media.body)).toEqual([
      { offset: 0, length: 3 },
      { offset: 3, length: 2 },
    ]);
    await expect(readAdapterMediaBody(loaded.media, loaded.body)).resolves.toEqual([
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5]),
    ]);
  });

  it("cancels already-open bodies when a later download fails", async () => {
    const cancel = vi.fn();
    const sources = extractTelegramInboundContent({
      audio: { file_id: "first" },
      voice: { file_id: "second" },
    }, "10").media;

    await expect(loadTelegramInboundMedia(sources, {
      getFile: async (fileId) => {
        if (fileId === "second") throw new Error("provider failed");
        return { file_size: 1, file_path: fileId };
      },
      downloadFile: async () => ({
        length: 1,
        stream: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1]));
          },
          cancel,
        }),
      }),
    })).rejects.toThrow("provider failed");
    expect(cancel).toHaveBeenCalledOnce();
  });
});
