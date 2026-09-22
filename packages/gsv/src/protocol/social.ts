import { z } from "zod/mini";
import { actorIdSchema, actorRefSchema, originMessageRefSchema, socialIdSchema, type OriginMessageRef } from "./social-identity";
export * from "./social-identity";
import type { FederationWorkDelivery, WorkRecord } from "./work";
import { federationContextConsentRequestSchema, federationContextConsentDecisionSchema, federationContextWithdrawalSchema, type FederationContextDelivery } from "./shared-context";
import {
  federationPublicKeySchema,
  federationRequestDetailsSchema,
  federationRequestKindSchema,
  federationRequestTitleSchema,
  federationResourceDescriptorSchema,
  MAX_FEDERATION_MESSAGE_BYTES,
  MAX_FEDERATION_MESSAGE_RESOURCES,
  type FederationDeliveryEnvelope,
  type FederationDeliveryPayload,
  type FederationDeliveryReceipt,
  type FederationMessageDelivery,
  type FederationPublicKey,
  type FederationContactRevokedDelivery,
} from "./syscalls/contact";

export type SocialMessageProvenance =
  | { kind: "human" }
  | { kind: "process"; processId: string }
  | { kind: "approved"; processId: string; approvalId: string };

export type SocialMessageMetadata = {
  threadId: string;
  reference: OriginMessageRef;
  provenance: SocialMessageProvenance;
  replyTo?: OriginMessageRef;
};

export type FederationFeature = "messages" | "approaches" | "work" | "context";
export type FederationShipDocumentV2 = {
  version: 2;
  domain: "gsv-federation/2/ship";
  shipId: string;
  origin: string;
  publicKey: FederationPublicKey;
  protocols: ["gsv-federation/2"];
  features: FederationFeature[];
  issuedAtMs: number;
  expiresAtMs: number;
  signature: string;
};

export type FederationMessageDeliveryV2 = FederationMessageDelivery & {
  social: SocialMessageMetadata;
};
export type FederationDeliveryPayloadV2 = FederationMessageDeliveryV2 | FederationContactRevokedDelivery | FederationWorkDelivery | FederationContextDelivery;
export type FederationDeliveryEnvelopeV2 = Omit<FederationDeliveryEnvelope, "version" | "payload"> & {
  version: 2;
  domain: "gsv-federation/2/delivery";
  payload: FederationDeliveryPayloadV2;
};
export type FederationDeliveryReceiptV2 = {
  version: 2;
  domain: "gsv-federation/2/receipt";
  deliveryId: string;
  signature: string;
};
export type FederationTransportPayload = FederationDeliveryPayload | FederationDeliveryPayloadV2;
export type FederationTransportEnvelope = FederationDeliveryEnvelope | FederationDeliveryEnvelopeV2;
export type FederationTransportReceipt = FederationDeliveryReceipt | FederationDeliveryReceiptV2;

export const socialMessageProvenanceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("human") }),
  z.strictObject({ kind: z.literal("process"), processId: socialIdSchema }),
  z.strictObject({ kind: z.literal("approved"), processId: socialIdSchema, approvalId: socialIdSchema }),
]) satisfies z.ZodMiniType<SocialMessageProvenance>;
export const socialMessageMetadataSchema = z.strictObject({
  threadId: actorIdSchema,
  reference: originMessageRefSchema,
  provenance: socialMessageProvenanceSchema,
  replyTo: z.optional(originMessageRefSchema),
}) satisfies z.ZodMiniType<SocialMessageMetadata>;
export const federationFeatureSchema = z.enum(["messages", "approaches", "work", "context"]);
export const federationShipDocumentV2Schema = z.strictObject({
  version: z.literal(2),
  domain: z.literal("gsv-federation/2/ship"),
  shipId: actorIdSchema,
  origin: z.string().check(z.minLength(1), z.maxLength(2_048)),
  publicKey: federationPublicKeySchema,
  protocols: z.tuple([z.literal("gsv-federation/2")]),
  features: z.array(federationFeatureSchema).check(z.maxLength(4)),
  issuedAtMs: z.int().check(z.nonnegative()),
  expiresAtMs: z.int().check(z.nonnegative()),
  signature: z.string().check(z.minLength(1), z.maxLength(512)),
}) satisfies z.ZodMiniType<FederationShipDocumentV2>;

const encoder = new TextEncoder();
export const workActionSchema = z.enum(["withdraw", "accept", "reject", "start", "complete", "cancel", "acknowledge", "dispute"]);
export const workOfferSchema = z.strictObject({
  reference: z.strictObject({ actor: actorRefSchema, id: socialIdSchema }),
  kind: federationRequestKindSchema,
  title: federationRequestTitleSchema,
  details: z.optional(federationRequestDetailsSchema),
  createdAtMs: z.int().check(z.nonnegative()),
});
export const workOperationSchema = z.strictObject({
  id: socialIdSchema, revision: z.int().check(z.minimum(1), z.maximum(8)), action: workActionSchema,
  observedPeerRevision: z.int().check(z.nonnegative(), z.maximum(8)),
  note: z.optional(z.string().check(z.maxLength(1024), z.refine((value) => encoder.encode(value).length <= 1024))),
});
const workStreamSchema = z.array(workOperationSchema).check(z.maxLength(8));
export const workRecordSchema = z.strictObject({ offer: workOfferSchema, requester: workStreamSchema, performer: workStreamSchema }) satisfies z.ZodMiniType<WorkRecord>;
export const federationWorkDeliverySchema = z.strictObject({
  kind: z.literal("work"), offer: workOfferSchema, participant: z.enum(["requester", "performer"]), operations: workStreamSchema,
}) satisfies z.ZodMiniType<FederationWorkDelivery>;
export const federationDeliveryPayloadV2Schema = z.discriminatedUnion("kind", [
  federationContextConsentRequestSchema, federationContextConsentDecisionSchema, federationContextWithdrawalSchema,
  federationWorkDeliverySchema,
  z.strictObject({
    kind: z.literal("message"),
    messageId: socialIdSchema,
    threadId: actorIdSchema,
    text: z.string().check(z.maxLength(MAX_FEDERATION_MESSAGE_BYTES), z.refine((value) => encoder.encode(value).length <= MAX_FEDERATION_MESSAGE_BYTES)),
    resources: z.optional(z.array(federationResourceDescriptorSchema).check(z.maxLength(MAX_FEDERATION_MESSAGE_RESOURCES))),
    social: socialMessageMetadataSchema,
  }).check(z.refine((value) => value.text.trim().length > 0 || (value.resources?.length ?? 0) > 0)),
  z.strictObject({ kind: z.literal("contact.revoked"), generation: actorIdSchema }),
]) satisfies z.ZodMiniType<FederationDeliveryPayloadV2>;

export const federationDeliveryEnvelopeV2Schema = z.strictObject({
  version: z.literal(2),
  domain: z.literal("gsv-federation/2/delivery"),
  deliveryId: socialIdSchema,
  senderShipId: actorIdSchema,
  senderSubjectId: actorIdSchema,
  recipientSubjectId: actorIdSchema,
  generation: actorIdSchema,
  timestampMs: z.int().check(z.nonnegative()),
  nonce: actorIdSchema,
  payload: federationDeliveryPayloadV2Schema,
  signature: z.string().check(z.minLength(1), z.maxLength(512)),
}) satisfies z.ZodMiniType<FederationDeliveryEnvelopeV2>;
export const federationDeliveryReceiptV2Schema = z.strictObject({
  version: z.literal(2),
  domain: z.literal("gsv-federation/2/receipt"),
  deliveryId: socialIdSchema,
  signature: z.string().check(z.minLength(1), z.maxLength(512)),
}) satisfies z.ZodMiniType<FederationDeliveryReceiptV2>;
