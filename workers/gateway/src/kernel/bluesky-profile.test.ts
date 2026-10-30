import { AppBskyActorProfile } from "@atcute/bluesky";
import { safeParse } from "@atcute/lexicons/validations";
import type { ShipProfileRecord } from "@humansandmachines/gsv/protocol";
import { describe, expect, it } from "vitest";
import { blueskyProfile, type BlueskyProfileRecord } from "./bluesky-profile";

const PAGE = "https://alice.ship.test/profile";
// A picture's CID as the repository names it (CIDv1, raw, SHA-256).
const CID = "bafkreibbrlmfuiz676bjmgfgqznlnajcfnzuyywtlizlh2v5lq35rfc7qy";
const PNG = { $type: "blob", ref: { $link: CID }, mimeType: "image/png", size: 12 } as const;
const RECORD: ShipProfileRecord = { $type: "space.ship.profile", displayName: "Alice", about: "Hello from my Ship", contactPolicy: "requests" };
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Whether Bluesky's lexicon accepts the record, as the open-network host checks it before committing. */
function accepted(record: BlueskyProfileRecord): boolean {
  return safeParse(AppBskyActorProfile.mainSchema, record).ok;
}

function graphemes(text: string): number {
  return [...segmenter.segment(text)].length;
}

function bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

describe("the Ship's profile as Bluesky shows it", () => {
  it("carries the name, the bio and the picture, and links to the Ship's own page", () => {
    const profile = blueskyProfile({ ...RECORD, avatar: PNG }, PAGE);
    expect(profile).toEqual({ $type: "app.bsky.actor.profile", displayName: "Alice", description: "Hello from my Ship", avatar: PNG, website: PAGE });
    expect(accepted(profile)).toBe(true);
  });

  it("leaves out an empty bio, and the picture when the host has its file down", () => {
    const { about: _about, ...unwritten } = RECORD;
    expect(blueskyProfile(unwritten, PAGE)).toEqual({ $type: "app.bsky.actor.profile", displayName: "Alice", website: PAGE });
    expect(blueskyProfile({ ...RECORD, avatar: PNG }, PAGE, false)).not.toHaveProperty("avatar");
  });

  it("shows a PNG or JPEG picture and leaves out a WebP one, which Bluesky doesn't accept", () => {
    const jpeg = { ...PNG, mimeType: "image/jpeg" } as const;
    expect(blueskyProfile({ ...RECORD, avatar: jpeg }, PAGE).avatar).toEqual(jpeg);
    expect(blueskyProfile({ ...RECORD, avatar: { ...PNG, mimeType: "image/webp" } }, PAGE)).not.toHaveProperty("avatar");
  });

  it("keeps a name and bio within Bluesky's limits as they are", () => {
    const name = "n".repeat(64);
    const about = "語".repeat(256);
    expect(blueskyProfile({ ...RECORD, displayName: name, about }, PAGE)).toMatchObject({ displayName: name, description: about });
  });

  it.each<[string, string, string, number]>([
    ["a name over 64 characters", "displayName", "a".repeat(80), 64],
    ["a bio over 256 characters", "description", "語".repeat(2_048), 256],
    ["a bio over 2,560 bytes", "description", "👩‍👩‍👧‍👦".repeat(200), 103],
  ])("cuts %s between characters and ends it with an ellipsis", (_label, field, text, expected) => {
    const record = field === "displayName" ? { ...RECORD, displayName: text } : { ...RECORD, about: text };
    const profile = blueskyProfile(record, PAGE);
    const fitted = field === "displayName" ? profile.displayName : profile.description!;
    expect(fitted.endsWith("…")).toBe(true);
    expect(graphemes(fitted)).toBe(expected);
    expect(text.startsWith(fitted.slice(0, -1))).toBe(true);
    expect(bytes(fitted)).toBeLessThanOrEqual(field === "displayName" ? 640 : 2_560);
    expect(accepted(profile)).toBe(true);
  });

  it("drops the space before the ellipsis where a cut falls after a word", () => {
    const profile = blueskyProfile({ ...RECORD, about: "word ".repeat(100) }, PAGE);
    expect(profile.description).toBe(`${"word ".repeat(51).trimEnd()}…`);
  });
});
