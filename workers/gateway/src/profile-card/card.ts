import { toBase64Pad } from "@atcute/multibase";
import { Resvg, initWasm } from "@resvg/resvg-wasm";
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";
// Satori stays at 0.32: later releases compile a text shaper from bytes when imported, which Workers forbid.
import satori, { init as initLayout, type SatoriOptions } from "satori/standalone";
import layoutWasm from "satori/yoga.wasm";
import type { ProfileAvatarFile } from "../kernel/profile-store";
// Satori reads WOFF but not WOFF2, and draws a variable font only at its default weight, so the fonts
// are static WOFF instances of web/public/fonts/HostGrotesk-Variable.woff2 and MartianMono-Variable.woff2.
// ship.png.bin is the app icon's ship on a clear ground, faded towards its edges, so the card draws it
// without masks or gradients.
import groteskRegular from "./host-grotesk-400.woff.bin";
import groteskSemibold from "./host-grotesk-600.woff.bin";
import martianMono from "./martian-mono.woff.bin";
import shipArt from "./ship.png.bin";

/** What a profile's link preview card shows. */
export type ProfileCard = {
  /** The Ship's host, as its address shows it. */
  host: string;
  handle?: string;
  displayName: string;
  about: string;
  /** Whether the card invites a message request. */
  requests: boolean;
  picture: ProfileAvatarFile | null;
};

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;
/** A picture larger than this a side is left off: decoding it would take more memory than a card is worth. */
const PICTURE_MAX_SIDE = 2048;
/** More about text than two lines show is never laid out. */
const ABOUT_MAX = 200;

const FONTS: SatoriOptions["fonts"] = [
  { name: "Host Grotesk", data: groteskRegular, weight: 400, style: "normal" },
  { name: "Host Grotesk", data: groteskSemibold, weight: 600, style: "normal" },
  { name: "Martian Mono", data: martianMono, weight: 400, style: "normal" },
];
const SHIP = `data:image/png;base64,${toBase64Pad(new Uint8Array(shipArt))}`;
// The violet glow from the bottom right corner, as an SVG gradient: Satori draws a CSS radial gradient as
// a masked pattern, which takes longer to render than the rest of the card together.
const GLOW = `data:image/svg+xml;base64,${toBase64Pad(new TextEncoder().encode(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}"><radialGradient id="glow" gradientUnits="userSpaceOnUse" cx="1104" cy="693" r="1303.5"><stop offset="0" stop-color="#6953ca" stop-opacity=".45"/><stop offset=".55" stop-color="#6953ca" stop-opacity="0"/></radialGradient><rect width="100%" height="100%" fill="url(#glow)"/></svg>`,
))}`;
/** Each star's place, in percent of the card, and its radius in pixels: around the text, never among it. */
const STARS: ReadonlyArray<readonly [x: number, y: number, radius: number]> = [
  [22, 5, 1], [40, 17, 1], [58, 7, 1.5], [80, 21, 1], [3, 40, 1], [74, 36, 1],
  [97, 30, 1], [77, 74, 1.5], [8, 94, 1], [33, 96, 1], [52, 91, 1], [70, 95, 1],
];

let engines: Promise<unknown> | undefined;

/** The profile's link preview card, a 1200×630 PNG in the profile page's look. */
export async function renderProfileCard(card: ProfileCard): Promise<Uint8Array> {
  engines ??= Promise.all([initLayout(layoutWasm), initWasm(resvgWasm)]);
  await engines;
  const resvg = new Resvg(await layout(card, pictureUri(card.picture)));
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

/** Characters the card's fonts lack: emoji and symbols, which the card leaves out, and letters, which leave their text off. */
export type MissingCharacters = { symbols: Set<string>; letters: Set<string> };

/**
 * The card as SVG. Satori names each run of characters its fonts lack; when there are any, the card is
 * laid out again without them, as an empty box would draw in their place.
 */
async function layout(card: ProfileCard, picture: string | undefined): Promise<string> {
  const missing: MissingCharacters = { symbols: new Set(), letters: new Set() };
  const draw = () => satori(cardElement(cardText(card, missing), card, picture), {
    width: CARD_WIDTH, height: CARD_HEIGHT, fonts: FONTS,
    loadAdditionalAsset: async (code, segment) => {
      const into = code === "emoji" || code === "symbol" ? missing.symbols : missing.letters;
      for (const character of segment) into.add(character);
      return [];
    },
  });
  const svg = await draw();
  return missing.symbols.size || missing.letters.size ? await draw() : svg;
}

type CardText = { title: string; handle?: string; about?: string };

/** The name, or the handle when the name is the handle or can't be drawn, or the host for a Ship with neither. */
export function cardText(card: ProfileCard, missing: MissingCharacters): CardText {
  const name = drawable(card.displayName, missing);
  const handle = card.handle ? `@${card.handle}` : undefined;
  const about = drawable(Array.from(card.about.trim().replace(/\s+/g, " ")).slice(0, ABOUT_MAX).join(""), missing);
  const named = name !== undefined && name !== card.handle;
  return {
    title: named ? name : handle ?? card.host,
    ...(named && handle ? { handle } : undefined),
    ...(about ? { about } : undefined),
  };
}

/** A symbol leaves with the space before it, so no gap is left where it was. */
function drawable(text: string, missing: MissingCharacters): string | undefined {
  const characters = Array.from(text);
  if (characters.some((character) => missing.letters.has(character))) return undefined;
  let kept = "";
  for (const character of characters) kept = missing.symbols.has(character) ? kept.trimEnd() : kept + character;
  return kept.replace(/\s+/g, " ").trim() || undefined;
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

// Satori clamps lines only in a block box.
type Style = { [property: string]: string | number };
type CardNode = string | { type: "div" | "span"; props: { style: Style; children?: CardNode | CardNode[] } } | { type: "img"; props: { src: string; style: Style } };

/** Satori reads a list of children as several, even an empty one. */
function box(style: Style, ...children: CardNode[]): CardNode {
  return { type: "div", props: { style, ...(children.length ? { children: children.length === 1 ? children[0] : children } : undefined) } };
}

function span(style: Style, text: string): CardNode {
  return { type: "span", props: { style, children: text } };
}

function image(src: string, style: Style): CardNode {
  return { type: "img", props: { src, style } };
}

function cardElement(text: CardText, card: ProfileCard, picture: string | undefined): CardNode {
  const length = Array.from(text.title).length;
  const size = length <= 10 ? 92 : length <= 16 ? 76 : length <= 24 ? 60 : 48;
  return box({
    width: CARD_WIDTH, height: CARD_HEIGHT, display: "flex", position: "relative",
    backgroundColor: "#07061a", color: "#e3dfeb", fontFamily: "Host Grotesk",
  },
  image(GLOW, { position: "absolute", left: 0, top: 0, width: CARD_WIDTH, height: CARD_HEIGHT }),
  ...STARS.map(([x, y, radius]) => box({
    position: "absolute", left: `${x}%`, top: `${y}%`, width: radius * 2, height: radius * 2,
    borderRadius: radius, backgroundColor: "#b3aee2", opacity: 0.8,
  })),
  image(SHIP, { position: "absolute", right: -60, top: 40, width: 512, height: 512 }),
  // Satori leaves padding out of a box's size, so the content sits in its own box.
  box({ position: "absolute", left: 72, top: 64, width: CARD_WIDTH - 144, height: CARD_HEIGHT - 128, display: "flex", flexDirection: "column" },
    box({ display: "flex", justifyContent: "space-between", alignItems: "baseline", fontFamily: "Martian Mono", fontSize: 22 },
      span({ color: "#8071dd", letterSpacing: 4.8, textShadow: "0 0 6px rgba(140, 120, 235, .7), 0 0 18px rgba(110, 95, 209, .35)" }, "Ship"),
      span({ color: "#9892a3" }, card.host)),
    box({ display: "flex", flexGrow: 1, alignItems: "center", gap: 44, maxWidth: 780 },
      ...(picture ? [image(picture, { width: 200, height: 200, objectFit: "cover", border: "1px solid rgba(176, 155, 233, .45)", flexShrink: 0 })] : []),
      box({ display: "flex", flexDirection: "column", minWidth: 0, flexShrink: 1 },
        box({ display: "block", fontSize: size, fontWeight: 600, letterSpacing: -size * 0.035, lineHeight: 1.02, lineClamp: 2 }, text.title),
        ...(text.handle ? [box({ marginTop: 14, fontFamily: "Martian Mono", fontSize: 24, color: "#b09be9" }, text.handle)] : []),
        ...(text.about ? [box({ display: "block", marginTop: 18, fontSize: 30, lineHeight: 1.35, color: "#b9b3c5", lineClamp: 2 }, text.about)] : []))),
    ...(card.requests ? [box({ display: "flex", fontFamily: "Martian Mono", fontSize: 20, color: "#b09be9", letterSpacing: 0.8 },
      "Message me from your Ship", span({ fontFamily: "Host Grotesk", marginLeft: 10 }, "↗"))] : [])));
}
