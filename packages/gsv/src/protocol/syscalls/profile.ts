import { z } from "zod/mini";
import { actorRefSchema, type ActorRef } from "../social";
import { federationPublicKeySchema, type FederationPublicKey } from "./contact";

export type ProfileFields = {
  alias: string;
  displayName: string;
  about: string;
  contactPolicy: "requests" | "invitation" | "closed";
  representation: "human" | "human-and-ship";
};

export type ProfileState = {
  revision: number;
  draft: ProfileFields;
  published?: { url: string; revision: number };
  publishing: boolean;
  publicationFailed: boolean;
};

export type PublicProfile = ProfileFields & {
  version: 2;
  domain: "gsv-federation/2/profile";
  actor: ActorRef;
  publicKey: FederationPublicKey;
  origin: string;
  url: string;
  revision: number;
  publishedAtMs: number;
  signature: string;
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
const profileShape = {
  alias: publicProfileAliasSchema,
  displayName: z.string().check(z.minLength(1), z.maxLength(80)),
  about: z.string().check(z.maxLength(2_048)),
  contactPolicy: z.enum(["requests", "invitation", "closed"]),
  representation: z.enum(["human", "human-and-ship"]),
};
export const profileFieldsSchema = z.strictObject(profileShape) satisfies z.ZodMiniType<ProfileFields>;
export const publicProfileSchema = z.strictObject({
  ...profileShape,
  version: z.literal(2), domain: z.literal("gsv-federation/2/profile"),
  actor: actorRefSchema, publicKey: federationPublicKeySchema,
  origin: z.string().check(z.maxLength(2_048)), url: z.string().check(z.maxLength(2_048)),
  revision: z.int().check(z.positive()), publishedAtMs: z.int().check(z.positive()),
  signature: z.string().check(z.minLength(1), z.maxLength(512)),
}) satisfies z.ZodMiniType<PublicProfile>;
