import { z } from "zod/mini";
import { PROFILE_AVATAR_MIME_TYPES } from "../generated/ship-lexicons";

/** What visitors may do: send a message request, ask for an invitation, or nothing. */
export type ProfileContactPolicy = "requests" | "invitation" | "closed";

export type ProfileFields = {
  displayName: string;
  about: string;
  contactPolicy: ProfileContactPolicy;
};

/** A profile picture is a PNG, JPEG or WebP of at most 1 MB. */
export { PROFILE_AVATAR_MAX_BYTES, PROFILE_AVATAR_MIME_TYPES } from "../generated/ship-lexicons";
export type ProfileAvatarMimeType = (typeof PROFILE_AVATAR_MIME_TYPES)[number];

/** A profile picture, named by the CID of its bytes. */
export type ProfileAvatar = { cid: string; mimeType: ProfileAvatarMimeType; size: number };

export type ProfileState = {
  revision: number;
  url: string;
  draft: ProfileFields;
  /** The draft's picture, which publishing makes public with the rest of the draft. */
  avatar?: ProfileAvatar;
  /** The live record; `contactPolicy` is what visitors can do now, which unpublished changes may differ from. */
  published?: {
    url: string;
    cid: string;
    contactPolicy: ProfileContactPolicy;
    /** The draft revision the record holds; a later draft revision is an unpublished change. */
    revision: number;
  };
  /** The space's recorded handle, which names the profile; absent when the installation has none. */
  handle?: string;
};

/** Another Ship's public profile, read from its `space.ship.profile` record. */
export type PublicProfile = {
  did: string;
  /** Its handle, checked both ways against the DID. */
  handle: string;
  /** The record's CID; a message request names the version its sender read. */
  cid: string;
  displayName: string;
  about: string;
  /** A value this Ship doesn't know reads as closed. */
  contactPolicy: ProfileContactPolicy;
  /** The profile page people share. */
  url: string;
};

export type ProfileGetArgs = Record<string, never>;
export type ProfileGetResult = { profile: ProfileState };
export type ProfileUpdateArgs = { expectedRevision: number; draft: ProfileFields };
export type ProfileUpdateResult = ProfileGetResult;
export type ProfilePublishArgs = { expectedRevision: number };
export type ProfilePublishResult = ProfileGetResult;
export type ProfileUnpublishArgs = { expectedRevision: number };
export type ProfileUnpublishResult = ProfileGetResult;
/** A handle, with or without its @, or a link to a profile page. */
export type ProfileResolveArgs = { address: string };
export type ProfileResolveResult = { profile: PublicProfile };
/** The request body carries the picture, of declared length; it replaces the draft's picture. */
export type ProfileAvatarSetArgs = { expectedRevision: number; mimeType: ProfileAvatarMimeType };
export type ProfileAvatarSetResult = ProfileGetResult;
export type ProfileAvatarRemoveArgs = { expectedRevision: number };
export type ProfileAvatarRemoveResult = ProfileGetResult;
/** The draft's or the published picture; the response body carries it. */
export type ProfileAvatarReadArgs = { cid: string };
export type ProfileAvatarReadResult = ProfileAvatar;

export const profileFieldsSchema = z.strictObject({
  displayName: z.string().check(z.minLength(1), z.maxLength(80)),
  about: z.string().check(z.maxLength(2_048)),
  contactPolicy: z.enum(["requests", "invitation", "closed"]),
}) satisfies z.ZodMiniType<ProfileFields>;

/** Where a Ship keeps its public profile: one record in its repository. */
export { SHIP_PROFILE_COLLECTION, SHIP_PROFILE_RKEY } from "../generated/ship-lexicons";

/** Where the Ship keeps a public profile as Bluesky shows it: one `app.bsky.actor.profile` record beside its own. */
export const BLUESKY_PROFILE_COLLECTION = "app.bsky.actor.profile";
export const BLUESKY_PROFILE_RKEY = "self";

/** A Ship's public profile as its `space.ship.profile` record holds it. */
export type { ShipProfileRecord } from "../generated/ship-lexicons";

/** Records come from any Ship, so fields a later version adds are ignored rather than refused. */
export { shipProfileRecordSchema } from "../generated/ship-lexicons";

/** What a record's contact policy lets visitors do; a value this Ship doesn't know reads as closed. */
export function profileContactPolicy(value: string): ProfileContactPolicy {
  return value === "requests" || value === "invitation" ? value : "closed";
}
