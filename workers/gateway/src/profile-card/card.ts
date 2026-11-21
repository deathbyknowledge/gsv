import { toBase64Pad } from "@atcute/multibase";
import { Resvg, initWasm } from "@resvg/resvg-wasm";
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";
// Satori stays at 0.32: later releases compile a text shaper from bytes when imported, which Workers forbid.
import satori, { init as initLayout } from "satori/standalone";
import layoutWasm from "satori/yoga.wasm";
import {
  CARD_FONTS, CARD_HEIGHT, CARD_WIDTH, profileCardElement, type MissingCharacters, type ProfileCard,
} from "../../../../web/src/public/profile-card";
import type { ProfileAvatarFile } from "../kernel/profile-store";

/** The profile a card draws, with its picture as the Ship keeps it. */
export type ProfileCardSource = Omit<ProfileCard, "picture"> & { picture: ProfileAvatarFile | null };

/** A picture larger than this a side is left off: decoding it would take more memory than a card is worth. */
const PICTURE_MAX_SIDE = 2048;

let engines: Promise<unknown> | undefined;

/** The profile's link preview card as a PNG, in the design web/src/public/profile-card.ts lays out. */
export async function renderProfileCard({ picture, ...profile }: ProfileCardSource): Promise<Uint8Array> {
  engines ??= Promise.all([initLayout(layoutWasm), initWasm(resvgWasm)]);
  await engines;
  const uri = pictureUri(picture);
  const resvg = new Resvg(await layout(uri ? { ...profile, picture: uri } : profile));
  try {
    const image = resvg.render();
    try {
      return image.asPng();
    } finally {
      image.free();
    }
  } finally {
    resvg.free();
  }
}

/**
 * The card as SVG. Satori names each run of characters its fonts lack; when there are any, the card is
 * laid out again without them, as an empty box would draw in their place.
 */
async function layout(card: ProfileCard): Promise<string> {
  const missing: MissingCharacters = { symbols: new Set(), letters: new Set() };
  const draw = () => satori(profileCardElement(card, missing), {
    width: CARD_WIDTH, height: CARD_HEIGHT, fonts: CARD_FONTS,
    loadAdditionalAsset: async (code, segment) => {
      const into = code === "emoji" || code === "symbol" ? missing.symbols : missing.letters;
      for (const character of segment) into.add(character);
      return [];
    },
  });
  const svg = await draw();
  return missing.symbols.size || missing.letters.size ? await draw() : svg;
}

/** The picture as the card draws it: a PNG or JPEG of a size it decodes. The card's renderer can't draw WebP. */
function pictureUri(picture: ProfileAvatarFile | null): string | undefined {
  const size = picture ? pictureSize(picture.bytes) : null;
  if (!picture || !size || size.width > PICTURE_MAX_SIDE || size.height > PICTURE_MAX_SIDE) return undefined;
  return `data:${picture.mimeType};base64,${toBase64Pad(picture.bytes)}`;
}

/** A PNG's or JPEG's size, from its header, or null for any other bytes. */
export function pictureSize(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 24 && view.getUint32(0) === 0x89504e47 && view.getUint32(12) === 0x49484452) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes.length < 4 || view.getUint16(0) !== 0xffd8) return null;
  // A JPEG's frame header holds its size; each segment before it gives its own length.
  for (let offset = 2; offset + 9 <= bytes.length;) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    if (marker === 0xff) {
      offset += 1;
    } else if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) };
    } else {
      offset += 2 + view.getUint16(offset + 2);
    }
  }
  return null;
}
