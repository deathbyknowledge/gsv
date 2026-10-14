import { z } from "zod/mini";
import { actorRefSchema, type ActorRef } from "../social";
import { federationPublicKeySchema, type FederationPublicKey } from "./contact";

export type ProfileFields = {
  displayName: string;
  about: string;
  contactPolicy: "requests" | "invitation" | "closed";
  representation: "human" | "human-and-ship";
};

export type ProfileState = {
  revision: number;
  url: string;
  draft: ProfileFields;
  published?: { url: string; revision: number };
};

type ProfilePublication = ProfileFields & {
  actor: ActorRef;
  publicKey: FederationPublicKey;
  origin: string;
  url: string;
  revision: number;
  publishedAtMs: number;
  signature: string;
};

export type SpacePublicProfile = ProfilePublication & {
  version: 3;
  domain: "gsv-federation/3/profile";
};

/** Published v2 snapshots remain verifiable while other spaces upgrade. */
export type PublicProfile = SpacePublicProfile | ProfilePublication & {
  version: 2;
  domain: "gsv-federation/2/profile";
  alias: string;
};

export type ProfileGetArgs = Record<string, never>;
export type ProfileGetResult = { profile: ProfileState };
export type ProfileUpdateArgs = { expectedRevision: number; draft: ProfileFields };
export type ProfileUpdateResult = ProfileGetResult;
export type ProfilePublishArgs = { expectedRevision: number };
export type ProfilePublishResult = ProfileGetResult;
export type ProfileUnpublishArgs = { expectedRevision: number };
export type ProfileUnpublishResult = ProfileGetResult;
export type ProfileResolveArgs = { url: string };
export type ProfileResolveResult = { profile: PublicProfile };

export const publicProfileAliasSchema = z.string().check(z.regex(/^[a-z][a-z0-9_-]{1,31}$/));
const profileFields = {
  displayName: z.string().check(z.minLength(1), z.maxLength(80)),
  about: z.string().check(z.maxLength(2_048)),
  contactPolicy: z.enum(["requests", "invitation", "closed"]),
  representation: z.enum(["human", "human-and-ship"]),
};
export const profileFieldsSchema = z.strictObject(profileFields) satisfies z.ZodMiniType<ProfileFields>;
const publicationFields = {
  ...profileFields,
  actor: actorRefSchema, publicKey: federationPublicKeySchema,
  origin: z.string().check(z.maxLength(2_048)), url: z.string().check(z.maxLength(2_048)),
  revision: z.int().check(z.positive()), publishedAtMs: z.int().check(z.positive()),
  signature: z.string().check(z.minLength(1), z.maxLength(512)),
};
export const publicProfileSchema = z.discriminatedUnion("version", [
  z.strictObject({ ...publicationFields, version: z.literal(3), domain: z.literal("gsv-federation/3/profile") }),
  z.strictObject({ ...publicationFields, version: z.literal(2), domain: z.literal("gsv-federation/2/profile"), alias: publicProfileAliasSchema }),
]) satisfies z.ZodMiniType<PublicProfile>;
