import { describe, expect, it } from "vitest";
import type { AdapterMedia } from "./types";
import { planTelegramMediaDeliveries } from "./telegram-media";

function media(type: AdapterMedia["type"], filename: string): AdapterMedia {
  return {
    type,
    filename,
    mimeType: type === "document" ? "application/pdf" : `${type}/test`,
    url: `https://example.com/${filename}`,
  };
}

function deliveryFilenames(deliveries: AdapterMedia[][]): string[][] {
  return deliveries.map((delivery) =>
    delivery.map((item) => item.filename ?? "")
  );
}

describe("planTelegramMediaDeliveries", () => {
  it("splits mixed photos and documents without reordering them", () => {
    const deliveries = planTelegramMediaDeliveries([
      media("image", "image.png"),
      media("document", "document.pdf"),
    ]);

    expect(deliveryFilenames(deliveries)).toEqual([
      ["image.png"],
      ["document.pdf"],
    ]);
  });

  it("groups compatible photos and videos into one album", () => {
    const deliveries = planTelegramMediaDeliveries([
      media("image", "first.png"),
      media("video", "clip.mp4"),
      media("image", "second.png"),
    ]);

    expect(deliveryFilenames(deliveries)).toEqual([
      ["first.png", "clip.mp4", "second.png"],
    ]);
  });

  it("creates homogeneous document and audio albums", () => {
    const deliveries = planTelegramMediaDeliveries([
      media("document", "first.pdf"),
      media("document", "second.pdf"),
      media("audio", "first.mp3"),
      media("audio", "second.mp3"),
    ]);

    expect(deliveryFilenames(deliveries)).toEqual([
      ["first.pdf", "second.pdf"],
      ["first.mp3", "second.mp3"],
    ]);
  });

  it("splits the shared twenty-item maximum into Telegram-sized groups", () => {
    const attachments = Array.from({ length: 20 }, (_, index) =>
      media("document", `${index + 1}.pdf`)
    );

    const deliveries = planTelegramMediaDeliveries(attachments);

    expect(deliveries.map((delivery) => delivery.length)).toEqual([10, 10]);
    expect(deliveryFilenames(deliveries).flat()).toEqual(
      attachments.map((item) => item.filename),
    );
  });
});
