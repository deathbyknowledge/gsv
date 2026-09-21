import { z } from "zod/mini";
import { actorRefSchema, federationShipDocumentV2Schema, type ActorRef, type FederationShipDocumentV2 } from "./social";

export type ApproachRef = { actor: ActorRef; approachId: string };

export type ApproachState = "preparing" | "pending" | "accepting" | "accepted" | "declined" | "withdrawn" | "expired" | "blocked";
export type ApproachDeliveryState = "queued" | "received" | "failed" | "unconfirmed";

export type ApproachSummary = {
  id: string;
  direction: "incoming" | "outgoing";
  reference: ApproachRef;
  peer: ActorRef;
  displayName: string;
  conversationId: string;
  state: ApproachState;
  revision: number;
  delivery: ApproachDeliveryState;
  createdAtMs: number;
  updatedAtMs: number;
  expiresAtMs: number;
  acceptedAtMs?: number;
  contactId?: string;
  connection?: "connecting" | "connected" | "failed";
};

export type ApproachContent = {
  reference: ApproachRef;
  recipient: ActorRef;
  profileRevision: number;
  displayName: string;
  messageId: string;
  text: string;
  createdAtMs: number;
  expiresAtMs: number;
};

/** Private peer-bound setup material: never part of a list or Conversation record. */
export type ApproachSetup = { token: string };

export type ApproachEnvelope = {
  version: 2;
  domain: "gsv-federation/2/approach";
  document: FederationShipDocumentV2;
  content: ApproachContent;
  setup: ApproachSetup;
  signature: string;
};

export type ApproachClaim = {
  version: 2;
  domain: "gsv-federation/2/approach-claim";
  document: FederationShipDocumentV2;
  reference: ApproachRef;
  recipient: ActorRef;
  attemptId: string;
  token: string;
  signature: string;
};

export type ApproachConfirmation = {
  version: 2;
  domain: "gsv-federation/2/approach-confirmation";
  document: FederationShipDocumentV2;
  reference: ApproachRef;
  recipient: ActorRef;
  generation: string;
  attemptId: string;
  signature: string;
};

/** A durable outcome, verified with the already pinned peer key. No expiring discovery document. */
export type ApproachReceipt = {
  version: 2;
  domain: "gsv-federation/2/approach-receipt";
  reference: ApproachRef;
  recipient: ActorRef;
  fingerprint: string;
  signature: string;
};

export type ApproachClaimReceipt = {
  version: 2;
  domain: "gsv-federation/2/approach-claimed";
  reference: ApproachRef;
  recipient: ActorRef;
  attemptId: string;
  generation: string;
  threadId: string;
  signature: string;
};

export type ApproachConnectedReceipt = Omit<ApproachClaimReceipt, "domain" | "threadId"> & {
  domain: "gsv-federation/2/approach-connected";
};

export type ApproachWithdrawal = {
  version: 2;
  domain: "gsv-federation/2/approach-withdrawal";
  document: FederationShipDocumentV2;
  reference: ApproachRef;
  recipient: ActorRef;
  signature: string;
};

const opaqueId = z.string().check(z.minLength(1), z.maxLength(128));
const timestamp = z.int().check(z.positive());
const signature = z.string().check(z.minLength(1), z.maxLength(512));
const setupToken = z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/));

export const approachRefSchema = z.strictObject({ actor: actorRefSchema, approachId: opaqueId }) satisfies z.ZodMiniType<ApproachRef>;
const approachMetadata = {
  reference: approachRefSchema, recipient: actorRefSchema,
  profileRevision: z.int().check(z.positive()),
  displayName: z.string().check(z.minLength(1), z.maxLength(80)),
  messageId: opaqueId,
  createdAtMs: timestamp, expiresAtMs: timestamp,
};
export const approachMetadataSchema = z.strictObject(approachMetadata) satisfies z.ZodMiniType<Omit<ApproachContent, "text">>;
export const approachContentSchema = z.strictObject({ ...approachMetadata, text: z.string().check(z.minLength(1), z.maxLength(32_768)) }) satisfies z.ZodMiniType<ApproachContent>;

export const approachEnvelopeSchema = z.strictObject({
  version: z.literal(2), domain: z.literal("gsv-federation/2/approach"),
  document: federationShipDocumentV2Schema, content: approachContentSchema,
  setup: z.strictObject({ token: setupToken }), signature,
}) satisfies z.ZodMiniType<ApproachEnvelope>;

export const approachClaimSchema = z.strictObject({
  version: z.literal(2), domain: z.literal("gsv-federation/2/approach-claim"),
  document: federationShipDocumentV2Schema, reference: approachRefSchema,
  recipient: actorRefSchema, attemptId: opaqueId, token: setupToken, signature,
}) satisfies z.ZodMiniType<ApproachClaim>;

export const approachConfirmationSchema = z.strictObject({
  version: z.literal(2), domain: z.literal("gsv-federation/2/approach-confirmation"),
  document: federationShipDocumentV2Schema, reference: approachRefSchema,
  recipient: actorRefSchema, generation: opaqueId, attemptId: opaqueId, signature,
}) satisfies z.ZodMiniType<ApproachConfirmation>;

export const approachReceiptSchema = z.strictObject({
  version: z.literal(2), domain: z.literal("gsv-federation/2/approach-receipt"),
  reference: approachRefSchema, recipient: actorRefSchema,
  fingerprint: z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/)), signature,
}) satisfies z.ZodMiniType<ApproachReceipt>;

const claimOutcome = {
  version: z.literal(2), reference: approachRefSchema, recipient: actorRefSchema,
  attemptId: opaqueId, generation: opaqueId, signature,
};
export const approachClaimReceiptSchema = z.strictObject({
  ...claimOutcome, domain: z.literal("gsv-federation/2/approach-claimed"), threadId: opaqueId,
}) satisfies z.ZodMiniType<ApproachClaimReceipt>;
export const approachConnectedReceiptSchema = z.strictObject({
  ...claimOutcome, domain: z.literal("gsv-federation/2/approach-connected"),
}) satisfies z.ZodMiniType<ApproachConnectedReceipt>;
export const approachWithdrawalSchema = z.strictObject({
  version: z.literal(2), domain: z.literal("gsv-federation/2/approach-withdrawal"),
  document: federationShipDocumentV2Schema, reference: approachRefSchema, recipient: actorRefSchema, signature,
}) satisfies z.ZodMiniType<ApproachWithdrawal>;
