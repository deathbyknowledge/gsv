import { describe, expect, it } from "vitest";
import { renderWhatsAppQrImageUrl } from "./WhatsAppQrCode";

describe("WhatsApp QR rendering", () => {
  it("renders raw provider QR text into an image without echoing the payload", async () => {
    const payload = "sensitive-whatsapp-pairing-payload";
    const imageUrl = await renderWhatsAppQrImageUrl({ kind: "raw", value: payload });

    expect(imageUrl).toMatch(/^data:image\/svg\+xml,/);
    expect(decodeURIComponent(imageUrl)).not.toContain(payload);
  });

  it("passes through a declared image data URL", async () => {
    const imageUrl = "data:image/png;base64,AAAA";
    await expect(renderWhatsAppQrImageUrl({ kind: "data-url", value: imageUrl }))
      .resolves.toBe(imageUrl);
  });
});
