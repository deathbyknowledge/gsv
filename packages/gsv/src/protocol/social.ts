import { z } from "zod/mini";

/**
 * A Ship's DID, which names both the Ship and its person on the open network.
 * Ships create did:plc identities; did:web accounts other hosts keep resolve too.
 */
export const didSchema = z.string().check(
  z.maxLength(2_048),
  z.regex(/^did:(?:plc:[a-z2-7]{24}|web:[a-zA-Z0-9.-]+(?:%3[aA][0-9]{1,5})?)$/),
);

/** A message as its author's Ship names it. */
export type OriginMessageRef = { did: string; messageId: string };
export type SocialMessageProvenance =
  | { kind: "human" }
  | { kind: "process"; processId: string };

export type SocialMessageMetadata = {
  threadId: string;
  reference: OriginMessageRef;
  provenance: SocialMessageProvenance;
  replyTo?: OriginMessageRef;
};

export const socialIdSchema = z.string().check(z.minLength(1), z.maxLength(256));
const threadIdSchema = z.string().check(z.minLength(1), z.maxLength(128));
export const originMessageRefSchema = z.strictObject({
  did: didSchema,
  messageId: socialIdSchema,
}) satisfies z.ZodMiniType<OriginMessageRef>;
export const socialMessageProvenanceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("human") }),
  z.strictObject({ kind: z.literal("process"), processId: socialIdSchema }),
]) satisfies z.ZodMiniType<SocialMessageProvenance>;
export const socialMessageMetadataSchema = z.strictObject({
  threadId: threadIdSchema,
  reference: originMessageRefSchema,
  provenance: socialMessageProvenanceSchema,
  replyTo: z.optional(originMessageRefSchema),
}) satisfies z.ZodMiniType<SocialMessageMetadata>;
