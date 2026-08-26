import { z } from "zod";
import { jsonObjectSchema, type JsonObject } from "../json";
import type { ResourceBlock } from "../resource";

export const MAX_FEDERATION_MESSAGE_RESOURCES = 16;
export const MAX_FEDERATION_MESSAGE_BYTES = 32 * 1024;
export const MAX_FEDERATION_RESOURCE_BYTES = 48 * 1024 * 1024;
export const MAX_FEDERATION_MESSAGE_RESOURCE_BYTES = 48 * 1024 * 1024;
export const MAX_FEDERATION_REQUEST_KIND_BYTES = 128;
export const MAX_FEDERATION_REQUEST_TITLE_BYTES = 1_024;
export const MAX_FEDERATION_REQUEST_DETAILS_BYTES = 32 * 1024;

const federationTextEncoder = new TextEncoder();
const federationRequestKindSchema = z.string()
  .max(MAX_FEDERATION_REQUEST_KIND_BYTES)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/i);
const federationRequestTitleSchema = z.string()
  .min(1)
  .max(MAX_FEDERATION_REQUEST_TITLE_BYTES)
  .check(z.refine((value: string) => (
    value.trim().length > 0
      && federationTextEncoder.encode(value).byteLength <= MAX_FEDERATION_REQUEST_TITLE_BYTES
  )));
const federationRequestDetailsSchema = jsonObjectSchema.check(
  z.refine((value: JsonObject) => (
    federationTextEncoder.encode(JSON.stringify(value)).byteLength
      <= MAX_FEDERATION_REQUEST_DETAILS_BYTES
  )),
);
const federationMessageTextSchema = z.string()
  .max(MAX_FEDERATION_MESSAGE_BYTES)
  .check(z.refine((value: string) => (
    federationTextEncoder.encode(value).byteLength <= MAX_FEDERATION_MESSAGE_BYTES
  )));

export type FederationPublicKey = {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
};

export type FederationShipDocument = {
  version: 1;
  shipId: string;
  origin: string;
  publicKey: FederationPublicKey;
  protocols: ["gsv-federation/1"];
  issuedAtMs: number;
  signature: string;
};

export type FederationSubject = {
  id: string;
  displayName: string;
};

export type ContactState = "active" | "revoked";

export type ContactSummary = {
  id: string;
  ownerUid: number;
  state: ContactState;
  generation: string;
  remoteShipId: string;
  remoteSubject: FederationSubject;
  remoteOrigin: string;
  conversationId: string;
  createdAtMs: number;
  updatedAtMs: number;
  revokedAtMs?: number;
  lastReceivedAtMs?: number;
  lastDeliveredAtMs?: number;
};

export type ContactIdentityArgs = Record<string, never>;
export type ContactIdentityResult = {
  document: FederationShipDocument;
  subject: FederationSubject;
};

export type ContactInviteCreateArgs = {
  expiresInSeconds?: number;
};

export type ContactInviteCreateResult = {
  inviteId: string;
  code: string;
  expiresAtMs: number;
};

export type ContactInviteAcceptArgs = {
  code: string;
};

export type ContactInviteAcceptResult = {
  contact: ContactSummary;
};

export type ContactInviteState = "pending" | "accepted" | "expired" | "cancelled";

export type ContactInviteSummary = {
  inviteId: string;
  state: ContactInviteState;
  expiresAtMs: number;
  createdAtMs: number;
  cancelledAtMs?: number;
  acceptedAtMs?: number;
  contactId?: string;
  remoteShipId?: string;
  remoteSubjectId?: string;
};

export type ContactInviteListArgs = {
  includeTerminal?: boolean;
};

export type ContactInviteListResult = {
  invites: ContactInviteSummary[];
};

export type ContactInviteCancelArgs = {
  inviteId: string;
};

export type ContactInviteCancelResult = {
  invite: ContactInviteSummary;
};

export type ContactListArgs = {
  includeRevoked?: boolean;
};

export type ContactListResult = {
  contacts: ContactSummary[];
};

export type ContactRevokeArgs = {
  contactId: string;
};

export type ContactRevokeResult = {
  contact: ContactSummary;
};

export type ContactSendArgs = {
  contactId: string;
  text: string;
  media?: ResourceBlock[];
  idempotencyKey?: string;
};

export type ContactSendResult = {
  deliveryId: string;
  conversationId: string;
  state: "queued" | "delivered" | "failed";
};

export type ContactDeliveryStatus = {
  deliveryId: string;
  contactId: string;
  conversationId: string;
  state: "queued" | "delivered" | "failed";
  attemptCount: number;
  createdAtMs: number;
  updatedAtMs: number;
  deliveredAtMs?: number;
  lastError?: string;
};

export type ContactDeliveryGetArgs = {
  deliveryId: string;
};

export type ContactDeliveryGetResult = {
  delivery: ContactDeliveryStatus | null;
};

export type ContactRequestState =
  | "offered"
  | "accepted"
  | "rejected"
  | "active"
  | "completed"
  | "cancelled";

export type ContactRequestRecord = {
  id: string;
  remoteId?: string;
  contactId: string;
  contactGeneration: string;
  direction: "incoming" | "outgoing";
  kind: string;
  title: string;
  details?: JsonObject;
  state: ContactRequestState;
  revision: number;
  createdAtMs: number;
  updatedAtMs: number;
};

export type ContactRequestListArgs = {
  contactId?: string;
  includeTerminal?: boolean;
};

export type ContactRequestListResult = {
  requests: ContactRequestRecord[];
};

export type ContactRequestCreateArgs = {
  contactId: string;
  kind: string;
  title: string;
  details?: JsonObject;
  idempotencyKey?: string;
};

export type ContactRequestCreateResult = {
  request: ContactRequestRecord;
  deliveryId: string;
};

export type ContactRequestUpdateArgs = {
  requestId: string;
  expectedRevision?: number;
  state: Exclude<ContactRequestState, "offered">;
  details?: JsonObject;
  idempotencyKey?: string;
};

export type ContactRequestUpdateResult = {
  request: ContactRequestRecord;
  deliveryId: string;
};

export type FederationResourceDescriptor = {
  id: string;
  revision: string;
  contentType: string;
  size: number;
  mediaType?: "image" | "audio" | "video" | "document";
  filename?: string;
  duration?: number;
  transcription?: string;
};

export type FederationMessageDelivery = {
  kind: "message";
  messageId: string;
  threadId: string;
  text: string;
  resources?: FederationResourceDescriptor[];
  createdAtMs: number;
};

export type FederationRequestDelivery = {
  kind: "request";
  request: {
    id: string;
    kind: string;
    title: string;
    details?: JsonObject;
    state: "offered";
    revision: 1;
    createdAtMs: number;
    updatedAtMs: number;
  };
};

export type FederationRequestUpdateDelivery = {
  kind: "request.update";
  requestId: string;
  expectedRevision: number;
  state: Exclude<ContactRequestState, "offered">;
  details?: JsonObject;
  updatedAtMs: number;
};

export type FederationContactRevokedDelivery = {
  kind: "contact.revoked";
  generation: string;
  revokedAtMs: number;
};

export type FederationDeliveryPayload =
  | FederationMessageDelivery
  | FederationRequestDelivery
  | FederationRequestUpdateDelivery
  | FederationContactRevokedDelivery;

export type FederationDeliveryEnvelope = {
  version: 1;
  deliveryId: string;
  senderShipId: string;
  senderSubjectId: string;
  recipientSubjectId: string;
  generation: string;
  timestampMs: number;
  nonce: string;
  payload: FederationDeliveryPayload;
  signature: string;
};

export type FederationDeliveryReceipt = {
  version: 1;
  deliveryId: string;
  committedAtMs: number;
  signature: string;
};

export const federationPublicKeySchema = z.strictObject({
  kty: z.literal("EC"),
  crv: z.literal("P-256"),
  x: z.string().min(1).max(128),
  y: z.string().min(1).max(128),
}) satisfies z.ZodType<FederationPublicKey>;

const federationResourceIdSchema = z.string()
  .regex(/^resource:[A-Za-z0-9_-]{1,119}$/);

export const federationSubjectSchema = z.strictObject({
  id: z.string().min(1).max(128),
  displayName: z.string().min(1).max(256),
}) satisfies z.ZodType<FederationSubject>;

export const federationShipDocumentSchema = z.strictObject({
  version: z.literal(1),
  shipId: z.string().min(1).max(128),
  origin: z.string().min(1).max(2_048),
  publicKey: federationPublicKeySchema,
  protocols: z.tuple([z.literal("gsv-federation/1")]),
  issuedAtMs: z.number().int().nonnegative(),
  signature: z.string().min(1).max(512),
}) satisfies z.ZodType<FederationShipDocument>;

export const federationResourceDescriptorSchema = z.strictObject({
  id: federationResourceIdSchema,
  revision: z.string().min(1).max(1_024),
  contentType: z.string().min(1).max(256),
  size: z.number().int().nonnegative().max(MAX_FEDERATION_RESOURCE_BYTES),
  mediaType: z.optional(z.enum(["image", "audio", "video", "document"])),
  filename: z.optional(z.string().max(1_024)),
  duration: z.optional(z.number().finite().nonnegative()),
  transcription: z.optional(z.string().max(32_768)),
}) satisfies z.ZodType<FederationResourceDescriptor>;

const federationMessageDeliverySchema = z.strictObject({
  kind: z.literal("message"),
  messageId: z.string().min(1).max(256),
  threadId: z.string().min(1).max(128),
  text: federationMessageTextSchema,
  resources: z.optional(
    z.array(federationResourceDescriptorSchema).max(MAX_FEDERATION_MESSAGE_RESOURCES),
  ),
  createdAtMs: z.number().int().positive(),
}).check(z.refine((value: FederationMessageDelivery) => (
  value.text.trim().length > 0 || (value.resources?.length ?? 0) > 0
))) satisfies z.ZodType<FederationMessageDelivery>;

const federationRequestDeliverySchema = z.strictObject({
  kind: z.literal("request"),
  request: z.strictObject({
    id: z.string().min(1).max(256),
    kind: federationRequestKindSchema,
    title: federationRequestTitleSchema,
    details: z.optional(federationRequestDetailsSchema),
    state: z.literal("offered"),
    revision: z.literal(1),
    createdAtMs: z.number().int().positive(),
    updatedAtMs: z.number().int().positive(),
  }),
}) satisfies z.ZodType<FederationRequestDelivery>;

const contactRequestStateSchema = z.enum([
  "accepted",
  "rejected",
  "active",
  "completed",
  "cancelled",
]);

const federationRequestUpdateDeliverySchema = z.strictObject({
  kind: z.literal("request.update"),
  requestId: z.string().min(1).max(256),
  expectedRevision: z.number().int().positive(),
  state: contactRequestStateSchema,
  details: z.optional(federationRequestDetailsSchema),
  updatedAtMs: z.number().int().positive(),
}) satisfies z.ZodType<FederationRequestUpdateDelivery>;

const federationContactRevokedDeliverySchema = z.strictObject({
  kind: z.literal("contact.revoked"),
  generation: z.string().min(1).max(128),
  revokedAtMs: z.number().int().nonnegative(),
}) satisfies z.ZodType<FederationContactRevokedDelivery>;

export const federationDeliveryPayloadSchema = z.discriminatedUnion("kind", [
  federationMessageDeliverySchema,
  federationRequestDeliverySchema,
  federationRequestUpdateDeliverySchema,
  federationContactRevokedDeliverySchema,
]) satisfies z.ZodType<FederationDeliveryPayload>;

export const federationDeliveryEnvelopeSchema = z.strictObject({
  version: z.literal(1),
  deliveryId: z.string().min(1).max(256),
  senderShipId: z.string().min(1).max(128),
  senderSubjectId: z.string().min(1).max(128),
  recipientSubjectId: z.string().min(1).max(128),
  generation: z.string().min(1).max(128),
  timestampMs: z.number().int().nonnegative(),
  nonce: z.string().min(1).max(128),
  payload: federationDeliveryPayloadSchema,
  signature: z.string().min(1).max(512),
}) satisfies z.ZodType<FederationDeliveryEnvelope>;

export const federationDeliveryReceiptSchema = z.strictObject({
  version: z.literal(1),
  deliveryId: z.string().min(1).max(256),
  committedAtMs: z.number().int().nonnegative(),
  signature: z.string().min(1).max(512),
}) satisfies z.ZodType<FederationDeliveryReceipt>;
