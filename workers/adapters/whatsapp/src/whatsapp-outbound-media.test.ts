import { describe, expect, it, vi } from "vitest";

import {
  sendWhatsAppMediaMessage,
  WHATSAPP_MEDIA_BYTE_LIMITS,
  whatsAppMediaFilename,
} from "./whatsapp-outbound-media";

function api() {
  return {
    upload: vi.fn(async () => "media-1"),
    send: vi.fn(async () => ({ messageId: "wamid.sent" })),
  };
}

describe("WhatsApp outbound media", () => {
  it("uploads a binary document and sends it by media id with caption and filename", async () => {
    const graph = api();
    await expect(sendWhatsAppMediaMessage(
      graph,
      "34611111189",
      { type: "document", mimeType: "application/pdf", filename: "report.pdf", body: { offset: 0, length: 3 } },
      new Uint8Array([1, 2, 3]),
      "the report",
      "wamid.in",
    )).resolves.toEqual({ messageId: "wamid.sent" });
    expect(graph.upload).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]), "application/pdf", "report.pdf");
    expect(graph.send).toHaveBeenCalledWith({
      to: "34611111189",
      type: "document",
      document: { id: "media-1", caption: "the report", filename: "report.pdf" },
      context: { message_id: "wamid.in" },
    });
  });

  it("sends URL attachments as links and omits captions audio cannot carry", async () => {
    const graph = api();
    await sendWhatsAppMediaMessage(graph, "34611111189", { type: "image", mimeType: "image/png", url: "https://example.com/a.png" }, undefined, "look");
    expect(graph.upload).not.toHaveBeenCalled();
    expect(graph.send).toHaveBeenLastCalledWith({ to: "34611111189", type: "image", image: { link: "https://example.com/a.png", caption: "look" } });
    await sendWhatsAppMediaMessage(graph, "34611111189", { type: "audio", mimeType: "audio/ogg", url: "https://example.com/a.ogg" }, undefined, "listen");
    expect(graph.send).toHaveBeenLastCalledWith({ to: "34611111189", type: "audio", audio: { link: "https://example.com/a.ogg" } });
    await sendWhatsAppMediaMessage(graph, "34611111189", { type: "video", mimeType: "video/mp4", url: "https://example.com/a.mp4" }, undefined, "x".repeat(1025));
    expect(graph.send).toHaveBeenLastCalledWith({ to: "34611111189", type: "video", video: { link: "https://example.com/a.mp4" } });
  });

  it("rejects oversized uploads and attachments without a source before contacting Meta", async () => {
    const graph = api();
    await expect(sendWhatsAppMediaMessage(
      graph, "34611111189", { type: "image", mimeType: "image/png", body: { offset: 0, length: 1 } },
      new Uint8Array(WHATSAPP_MEDIA_BYTE_LIMITS.image + 1), undefined,
    )).rejects.toMatchObject({ kind: "permanent", message: expect.stringContaining("at most 5 MB") });
    await expect(sendWhatsAppMediaMessage(graph, "34611111189", { type: "image", mimeType: "image/png" }, undefined, undefined))
      .rejects.toMatchObject({ kind: "permanent" });
    expect(graph.upload).not.toHaveBeenCalled();
    expect(graph.send).not.toHaveBeenCalled();
  });

  it("derives filenames from the mime type when none is given", () => {
    expect(whatsAppMediaFilename({ type: "audio", mimeType: "audio/ogg; codecs=opus" })).toBe("attachment.ogg");
    expect(whatsAppMediaFilename({ type: "document", mimeType: "application/x-unknown" })).toBe("attachment.bin");
    expect(whatsAppMediaFilename({ type: "image", mimeType: "image/png", filename: " photo.png " })).toBe("photo.png");
  });
});
