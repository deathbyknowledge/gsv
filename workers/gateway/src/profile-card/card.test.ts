import { describe, expect, it } from "vitest";
import { CARD_HEIGHT, CARD_WIDTH, cardText, pictureSize, renderProfileCard, type MissingCharacters, type ProfileCard } from "./card";
import shipArt from "./ship.png.bin";

const CARD: ProfileCard = {
  host: "person.ship.example", handle: "person", displayName: "Person Example",
  about: "Builds things.", requests: true, picture: null,
};
const NOTHING_MISSING: MissingCharacters = { symbols: new Set(), letters: new Set() };

function missing(symbols: string, letters: string): MissingCharacters {
  return { symbols: new Set(Array.from(symbols)), letters: new Set(Array.from(letters)) };
}

function jpeg(width: number, height: number): Uint8Array {
  // Start of image, an APP0 segment of four bytes, then a baseline frame header.
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, height >> 8, height & 255, width >> 8, width & 255, 1, 1, 0x11, 0]);
}

describe("profile card", () => {
  it("names the profile, with its handle beneath a name that differs from it", () => {
    expect(cardText(CARD, NOTHING_MISSING)).toEqual({ title: "Person Example", handle: "@person", about: "Builds things." });
    expect(cardText({ ...CARD, displayName: "person", about: "  " }, NOTHING_MISSING)).toEqual({ title: "@person" });
    const { handle: _, ...unhandled } = CARD;
    expect(cardText(unhandled, NOTHING_MISSING)).toEqual({ title: "Person Example", about: "Builds things." });
  });

  it("leaves out emoji the fonts lack, and text written in letters they lack", () => {
    const glyphs = missing("🚀👋♥", "Привет");
    expect(cardText({ ...CARD, displayName: "🚀 Person 🚀", about: "Hi 👋 there, café ♥, done ♥" }, glyphs))
      .toEqual({ title: "Person", handle: "@person", about: "Hi there, café, done" });
    expect(cardText({ ...CARD, displayName: "🚀", about: "Привет" }, glyphs)).toEqual({ title: "@person" });
    const { handle: _, ...unhandled } = CARD;
    expect(cardText({ ...unhandled, displayName: "Привет" }, glyphs)).toEqual({ title: "person.ship.example", about: "Builds things." });
  });

  it("lays out no more about text than two lines show", () => {
    const about = cardText({ ...CARD, about: `${"word ".repeat(100)}\n\nend` }, NOTHING_MISSING).about!;
    expect(Array.from(about).length).toBeLessThanOrEqual(200);
    expect(about).not.toContain("\n");
  });

  it("reads a PNG's and a JPEG's size from its header, and nothing else's", () => {
    expect(pictureSize(new Uint8Array(shipArt))).toEqual({ width: 512, height: 512 });
    expect(pictureSize(jpeg(640, 480))).toEqual({ width: 640, height: 480 });
    expect(pictureSize(jpeg(9000, 9000))).toEqual({ width: 9000, height: 9000 });
    expect(pictureSize(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBeNull();
    expect(pictureSize(jpeg(640, 480).slice(0, 10))).toBeNull();
    expect(pictureSize(new Uint8Array())).toBeNull();
  });

  it("draws a 1200×630 PNG, whatever the profile's text and picture", async () => {
    const cards: ProfileCard[] = [
      CARD,
      { ...CARD, displayName: "山田 Zoë ★", about: "Hi 👋 — Привет, naïve café ♥", requests: false },
      { ...CARD, picture: { cid: "bafkreiship", mimeType: "image/png", size: shipArt.byteLength, bytes: new Uint8Array(shipArt) } },
      { ...CARD, picture: { cid: "bafkreihuge", mimeType: "image/jpeg", size: 21, bytes: jpeg(9000, 9000) } },
      { ...CARD, picture: { cid: "bafkreiwebp", mimeType: "image/webp", size: 16, bytes: new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 ") } },
    ];
    for (const card of cards) {
      const png = await renderProfileCard(card);
      const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
      expect(view.getUint32(0)).toBe(0x89504e47);
      expect([view.getUint32(16), view.getUint32(20)]).toEqual([CARD_WIDTH, CARD_HEIGHT]);
    }
  });
});
