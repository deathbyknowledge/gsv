import { describe, expect, it, vi } from "vitest";

import {
  binaryBodyFromOwnedBytes,
  readAdapterMediaBody,
} from "../../shared/src/media-body";
import {
  extractWhatsAppInboundContent,
  loadWhatsAppInboundMedia,
} from "./whatsapp-inbound-media";

describe("WhatsApp inbound media", () => {
  it("prefers the text body, then a caption, then a placeholder", () => {
    expect(extractWhatsAppInboundContent({ text: { body: " hi " } })).toEqual({ text: "hi", media: [] });
    expect(extractWhatsAppInboundContent({
      image: { id: "77", mime_type: "image/png", caption: "see this" },
    })).toEqual({
      text: "see this",
      media: [{ type: "image", mediaId: "77", mimeType: "image/png", filename: "whatsapp-image-77.png" }],
    });
    expect(extractWhatsAppInboundContent({ audio: { id: "78", mime_type: "audio/ogg; codecs=opus", voice: true } }).text)
      .toBe("[Voice note]");
    expect(extractWhatsAppInboundContent({ document: { id: "bad id" } })).toEqual({ text: null, media: [] });
  });

  it("looks media up, downloads it, and packs one binary frame body", async () => {
    const bytes = new Map([
      ["77", new Uint8Array([1, 2, 3])],
      ["78", new Uint8Array([4, 5])],
    ]);
    const content = extractWhatsAppInboundContent({
      image: { id: "77", mime_type: "image/jpeg" },
      audio: { id: "78", mime_type: "audio/ogg" },
    });
    const loaded = await loadWhatsAppInboundMedia(content.media, {
      lookupMedia: async (mediaId) => ({
        url: `https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=${mediaId}`,
        mimeType: mediaId === "77" ? "image/jpeg" : "audio/ogg",
        size: bytes.get(mediaId)!.byteLength,
      }),
      downloadMedia: async (url) => binaryBodyFromOwnedBytes(bytes.get(new URL(url).searchParams.get("mid")!)!),
    });

    expect(loaded.media.map((media) => [media.type, media.body, media.size])).toEqual([
      ["image", { offset: 0, length: 3 }, 3],
      ["audio", { offset: 3, length: 2 }, 2],
    ]);
    await expect(readAdapterMediaBody(loaded.media, loaded.body)).resolves.toEqual([
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5]),
    ]);
  });

  it("skips oversized or non-https media and cancels open bodies when a later download fails", async () => {
    const skipped = await loadWhatsAppInboundMedia(
      [{ type: "document", mediaId: "big", mimeType: "application/pdf" }],
      {
        lookupMedia: async () => ({ url: "http://insecure.example/file", size: 10 }),
        downloadMedia: async () => binaryBodyFromOwnedBytes(new Uint8Array([1])),
      },
    );
    expect(skipped.skipped).toBe(1);
    expect(skipped.media).toEqual([]);

    const cancel = vi.fn();
    await expect(loadWhatsAppInboundMedia(
      [
        { type: "audio", mediaId: "first", mimeType: "audio/ogg" },
        { type: "audio", mediaId: "second", mimeType: "audio/ogg" },
      ],
      {
        lookupMedia: async (mediaId) => {
          if (mediaId === "second") throw new Error("provider failed");
          return { url: "https://lookaside.fbsbx.com/first", size: 1 };
        },
        downloadMedia: async () => ({
          length: 1,
          stream: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1]));
            },
            cancel,
          }),
        }),
      },
    )).rejects.toThrow("provider failed");
    expect(cancel).toHaveBeenCalledOnce();
  });
});
