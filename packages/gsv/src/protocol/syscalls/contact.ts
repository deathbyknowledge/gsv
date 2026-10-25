import { z } from "zod/mini";
import { jsonObjectSchema, type JsonObject } from "../json";
import type { ResourceBlock } from "../resource";
import { socialMessageMetadataSchema, type OriginMessageRef, type SocialMessageMetadata } from "../social";

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

export type ContactState = "active" | "revoked";

export type ContactPreferences = {
  saved: boolean;
  muted: boolean;
  shipHandlesMessages: boolean;
  revision: number;
};

export const contactPreferencesPatchSchema = z.strictObject({
  saved: z.optional(z.boolean()),
  muted: z.optional(z.boolean()),
  shipHandlesMessages: z.optional(z.boolean()),
});
export type ContactPreferencesUpdateArgs = {
  contactId: string;
  expectedRevision: number;
  patch: Partial<Pick<ContactPreferences, "saved" | "muted" | "shipHandlesMessages">>;
};
export type ContactPreferencesUpdateResult = { contact: ContactSummary };
/** A person this Ship refuses to hear from, by DID. */
export type ContactBlock = { did: string; displayName?: string; createdAtMs: number };
export type ContactBlockSetArgs = { did: string; blocked: boolean };
export type ContactBlockSetResult = { block: ContactBlock | null };
export type ContactBlockListArgs = { did?: string; cursor?: string; limit?: number };
export type ContactBlockListResult = { blocks: ContactBlock[]; nextCursor?: string };

export type ContactSummary = {
  id: string;
  ownerUid: number;
  state: ContactState;
  generation: string;
  /** The other person's DID; a contact that ended before DIDs has none. */
  remoteDid?: string;
  /** The name they gave when you connected. */
  remoteName: string;
  /** Their handle, shown only once it and their DID name each other. */
  remoteHandle?: string;
  localAlias?: string;
  conversationId: string;
  createdAtMs: number;
  updatedAtMs: number;
  revokedAtMs?: number;
  lastReceivedAtMs?: number;
  lastDeliveredAtMs?: number;
  preferences?: ContactPreferences;
  blocked?: boolean;
};

export type ContactInviteCreateArgs = {
  expiresInSeconds?: number;
  /** Owner's choice for the new contact. Ship must supply it; older human clients may omit it. */
  shipHandlesMessages?: boolean;
};

export type ContactInviteCreateResult = {
  inviteId: string;
  code: string;
  /** Shareable link; older gateways return only the equivalent code. */
  url?: string;
  expiresAtMs: number;
};

export type ContactInviteAcceptArgs = {
  code: string;
  /** Owner's choice, retained for retries of this acceptance. Ship must supply it. */
  shipHandlesMessages?: boolean;
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
  remoteDid?: string;
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
  attentionNotice?: { previousContactAdded: boolean; previousReceived: boolean };
};

export type ContactNoticeDismissArgs = Record<string, never>;
export type ContactNoticeDismissResult = Record<string, never>;

export type ContactAliasSetArgs = {
  contactId: string;
  alias: string | null;
};

export type ContactAliasSetResult = {
  contact: ContactSummary;
};

export function contactDisplayName(
  contact: Pick<ContactSummary, "localAlias" | "remoteName">,
): string {
  return contact.localAlias ?? contact.remoteName;
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
  replyTo?: OriginMessageRef;
  media?: ResourceBlock[];
  idempotencyKey?: string;
  /** Continue this Ship responsibility when the contact replies. Local only. */
  responsibilityId?: string;
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
  retryable?: boolean;
  messageId?: string;
  messageSequence?: number;
};

export type ContactDeliveryGetArgs = {
  deliveryId: string;
};

export type ContactDeliveryGetResult = {
  delivery: ContactDeliveryStatus | null;
};

export type ContactDeliveryListArgs = { contactId: string; deliveryIds?: string[]; messageSequences?: number[] };
export type ContactDeliveryListResult = { deliveries: ContactDeliveryStatus[] };
export type ContactDeliveryRetryArgs = { deliveryId: string; expectedUpdatedAtMs: number };
export type ContactDeliveryRetryResult = ContactSendResult;

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
  /** Confirmation of this revision, independent of its locally recorded work state. */
  exchange?: ContactRequestExchange;
  createdAtMs: number;
  updatedAtMs: number;
};

export type ContactRequestExchange = {
  state: "pending" | "acknowledged" | "failed" | "unconfirmed";
  source?: "local" | "remote";
  deliveryId?: string;
  lastError?: string;
};

export function contactRequestTransitions(
  state: ContactRequestState,
  participant: "requester" | "performer",
): Exclude<ContactRequestState, "offered">[] {
  if (participant === "requester") return state === "offered" ? ["cancelled"] : [];
  if (state === "offered") return ["accepted", "rejected"];
  if (state === "accepted") return ["active", "completed", "cancelled"];
  if (state === "active") return ["completed", "cancelled"];
  return [];
}

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
  social: SocialMessageMetadata;
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

/** The sender removed the contact; the delivery's generation names which connection ended. */
export type FederationContactRevokedDelivery = {
  kind: "contact.revoked";
};

export type FederationDeliveryPayload =
  | FederationMessageDelivery
  | FederationRequestDelivery
  | FederationRequestUpdateDelivery
  | FederationContactRevokedDelivery;

const federationResourceIdSchema = z.string()
  .check(z.regex(/^resource:[A-Za-z0-9_-]{1,119}$/));

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
  social: socialMessageMetadataSchema,
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
}) satisfies z.ZodMiniType<FederationContactRevokedDelivery>;

export const federationDeliveryPayloadSchema = z.discriminatedUnion("kind", [
  federationMessageDeliverySchema,
  federationRequestDeliverySchema,
  federationRequestUpdateDeliverySchema,
  federationContactRevokedDeliverySchema,
]) satisfies z.ZodMiniType<FederationDeliveryPayload>;
