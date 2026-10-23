import { z } from "zod/mini";

/** What visitors may do: send a message request, ask for an invitation, or nothing. */
export type ProfileContactPolicy = "requests" | "invitation" | "closed";

export type ProfileFields = {
  displayName: string;
  about: string;
  contactPolicy: ProfileContactPolicy;
};

export type ProfileState = {
  revision: number;
  url: string;
  draft: ProfileFields;
  /** The live record; `contactPolicy` is what visitors can do now, which unpublished changes may differ from. */
  published?: { url: string; cid: string; contactPolicy: ProfileContactPolicy };
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

export const profileFieldsSchema = z.strictObject({
  displayName: z.string().check(z.minLength(1), z.maxLength(80)),
  about: z.string().check(z.maxLength(2_048)),
  contactPolicy: z.enum(["requests", "invitation", "closed"]),
}) satisfies z.ZodMiniType<ProfileFields>;
