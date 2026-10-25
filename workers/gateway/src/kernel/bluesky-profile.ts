import type { PublicBlobRef, ShipProfileRecord } from "@humansandmachines/gsv/protocol";
import { BLUESKY_PROFILE_COLLECTION } from "@humansandmachines/gsv/protocol";

/** A Ship's public profile as Bluesky shows it: its `app.bsky.actor.profile` record, which links to the Ship's own page. */
export type BlueskyProfileRecord = {
  $type: typeof BLUESKY_PROFILE_COLLECTION;
  displayName: string;
  description?: string;
  avatar?: PublicBlobRef;
  website: string;
};

/** Bluesky's limits, in characters as people count them and in UTF-8 bytes. */
type TextLimit = { graphemes: number; bytes: number };
const DISPLAY_NAME: TextLimit = { graphemes: 64, bytes: 640 };
const DESCRIPTION: TextLimit = { graphemes: 256, bytes: 2_560 };
/** Bluesky shows a PNG or JPEG picture; a Ship's pictures are already within its 1 MB. */
const PICTURE_TYPES = new Set(["image/png", "image/jpeg"]);
const ELLIPSIS = "…";

const encoder = new TextEncoder();
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * The Ship's profile as Bluesky shows it. A name or bio over Bluesky's limits
 * is cut between characters and ends with an ellipsis, while the Ship's own
 * record keeps it whole. A WebP picture, which Bluesky doesn't show, is left
 * out, as is any picture without `picture`.
 */
export function blueskyProfile(record: ShipProfileRecord, website: string, picture = true): BlueskyProfileRecord {
  const avatar = picture && record.avatar && PICTURE_TYPES.has(record.avatar.mimeType) ? record.avatar : null;
  return {
    $type: BLUESKY_PROFILE_COLLECTION,
    displayName: fitted(record.displayName, DISPLAY_NAME),
    ...(record.about ? { description: fitted(record.about, DESCRIPTION) } : undefined),
    ...(avatar ? { avatar: { $type: "blob", ref: { $link: avatar.ref.$link }, mimeType: avatar.mimeType, size: avatar.size } } : undefined),
    website,
  };
}

/** The text as it is when within the limit, else as much as fits before an ellipsis, without the space a cut after a word leaves. */
function fitted(text: string, limit: TextLimit): string {
  const characters = Array.from(segmenter.segment(text), ({ segment }) => segment);
  if (characters.length <= limit.graphemes && encoder.encode(text).byteLength <= limit.bytes) return text;
  let cut = "";
  let bytes = encoder.encode(ELLIPSIS).byteLength;
  for (const character of characters.slice(0, limit.graphemes - 1)) {
    bytes += encoder.encode(character).byteLength;
    if (bytes > limit.bytes) break;
    cut += character;
  }
  return `${cut.trimEnd()}${ELLIPSIS}`;
}
