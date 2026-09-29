import { z } from "zod/mini";
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
const federationRequestKindSchema = z.string().check(
  z.maxLength(MAX_FEDERATION_REQUEST_KIND_BYTES),
  z.regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/i),
);
const federationRequestTitleSchema = z.string()
  .check(z.minLength(1), z.maxLength(MAX_FEDERATION_REQUEST_TITLE_BYTES))
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
  .check(z.maxLength(MAX_FEDERATION_MESSAGE_BYTES))
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
  localAlias?: string;
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

export type ContactAliasSetArgs = {
  contactId: string;
  alias: string | null;
};

export type ContactAliasSetResult = {
  contact: ContactSummary;
};

export function contactDisplayName(
  contact: Pick<ContactSummary, "localAlias" | "remoteSubject">,
): string {
  return contact.localAlias ?? contact.remoteSubject.displayName;
}

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
  };
};

export type FederationRequestUpdateDelivery = {
  kind: "request.update";
  requestId: string;
  expectedRevision: number;
  state: Exclude<ContactRequestState, "offered">;
  details?: JsonObject;
};

export type FederationContactRevokedDelivery = {
  kind: "contact.revoked";
  generation: string;
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
  signature: string;
};

export const federationPublicKeySchema = z.strictObject({
  kty: z.literal("EC"),
  crv: z.literal("P-256"),
  x: z.string().check(z.minLength(1), z.maxLength(128)),
  y: z.string().check(z.minLength(1), z.maxLength(128)),
}) satisfies z.ZodMiniType<FederationPublicKey>;

const federationResourceIdSchema = z.string()
  .check(z.regex(/^resource:[A-Za-z0-9_-]{1,119}$/));

export const federationSubjectSchema = z.strictObject({
  id: z.string().check(z.minLength(1), z.maxLength(128)),
  displayName: z.string().check(z.minLength(1), z.maxLength(256)),
}) satisfies z.ZodMiniType<FederationSubject>;

export const federationShipDocumentSchema = z.strictObject({
  version: z.literal(1),
  shipId: z.string().check(z.minLength(1), z.maxLength(128)),
  origin: z.string().check(z.minLength(1), z.maxLength(2_048)),
  publicKey: federationPublicKeySchema,
  protocols: z.tuple([z.literal("gsv-federation/1")]),
  issuedAtMs: z.int().check(z.nonnegative()),
  signature: z.string().check(z.minLength(1), z.maxLength(512)),
}) satisfies z.ZodMiniType<FederationShipDocument>;

export const federationResourceDescriptorSchema = z.strictObject({
  id: federationResourceIdSchema,
  revision: z.string().check(z.minLength(1), z.maxLength(1_024)),
  contentType: z.string().check(z.minLength(1), z.maxLength(256)),
  size: z.int().check(z.nonnegative(), z.maximum(MAX_FEDERATION_RESOURCE_BYTES)),
  mediaType: z.optional(z.enum(["image", "audio", "video", "document"])),
  filename: z.optional(z.string().check(z.maxLength(1_024))),
  duration: z.optional(z.number().check(z.nonnegative())),
  transcription: z.optional(z.string().check(z.maxLength(32_768))),
}) satisfies z.ZodMiniType<FederationResourceDescriptor>;

const federationMessageDeliverySchema = z.strictObject({
  kind: z.literal("message"),
  messageId: z.string().check(z.minLength(1), z.maxLength(256)),
  threadId: z.string().check(z.minLength(1), z.maxLength(128)),
  text: federationMessageTextSchema,
  resources: z.optional(
    z.array(federationResourceDescriptorSchema).check(z.maxLength(MAX_FEDERATION_MESSAGE_RESOURCES)),
  ),
}).check(z.refine((value: FederationMessageDelivery) => (
  value.text.trim().length > 0 || (value.resources?.length ?? 0) > 0
))) satisfies z.ZodMiniType<FederationMessageDelivery>;

const federationRequestDeliverySchema = z.strictObject({
  kind: z.literal("request"),
  request: z.strictObject({
    id: z.string().check(z.minLength(1), z.maxLength(256)),
    kind: federationRequestKindSchema,
    title: federationRequestTitleSchema,
    details: z.optional(federationRequestDetailsSchema),
    state: z.literal("offered"),
    revision: z.literal(1),
  }),
}) satisfies z.ZodMiniType<FederationRequestDelivery>;

const contactRequestStateSchema = z.enum([
  "accepted",
  "rejected",
  "active",
  "completed",
  "cancelled",
]);

const federationRequestUpdateDeliverySchema = z.strictObject({
  kind: z.literal("request.update"),
  requestId: z.string().check(z.minLength(1), z.maxLength(256)),
  expectedRevision: z.int().check(z.positive()),
  state: contactRequestStateSchema,
  details: z.optional(federationRequestDetailsSchema),
}) satisfies z.ZodMiniType<FederationRequestUpdateDelivery>;

const federationContactRevokedDeliverySchema = z.strictObject({
  kind: z.literal("contact.revoked"),
  generation: z.string().check(z.minLength(1), z.maxLength(128)),
}) satisfies z.ZodMiniType<FederationContactRevokedDelivery>;

export const federationDeliveryPayloadSchema = z.discriminatedUnion("kind", [
  federationMessageDeliverySchema,
  federationRequestDeliverySchema,
  federationRequestUpdateDeliverySchema,
  federationContactRevokedDeliverySchema,
]) satisfies z.ZodMiniType<FederationDeliveryPayload>;

export const federationDeliveryEnvelopeSchema = z.strictObject({
  version: z.literal(1),
  deliveryId: z.string().check(z.minLength(1), z.maxLength(256)),
  senderShipId: z.string().check(z.minLength(1), z.maxLength(128)),
  senderSubjectId: z.string().check(z.minLength(1), z.maxLength(128)),
  recipientSubjectId: z.string().check(z.minLength(1), z.maxLength(128)),
  generation: z.string().check(z.minLength(1), z.maxLength(128)),
  timestampMs: z.int().check(z.nonnegative()),
  nonce: z.string().check(z.minLength(1), z.maxLength(128)),
  payload: federationDeliveryPayloadSchema,
  signature: z.string().check(z.minLength(1), z.maxLength(512)),
}) satisfies z.ZodMiniType<FederationDeliveryEnvelope>;

export const federationDeliveryReceiptSchema = z.strictObject({
  version: z.literal(1),
  deliveryId: z.string().check(z.minLength(1), z.maxLength(256)),
  signature: z.string().check(z.minLength(1), z.maxLength(512)),
}) satisfies z.ZodMiniType<FederationDeliveryReceipt>;
