import { z } from "zod/mini";
import { federationDeliveryPayloadSchema, type FederationDeliveryPayload } from "./syscalls/contact";

/*
 * Ship-to-Ship methods. Each call carries a service-auth token from the calling
 * Ship's DID, addressed to the receiving Ship's `#ship` service and naming the
 * method. The caller's identity is the token's issuer, never a field of the input.
 */

export const ACCEPT_INVITATION = "space.ship.acceptInvitation";
export const DELIVER = "space.ship.deliver";
export const GET_ATTACHMENT = "space.ship.getAttachment";
export const SEND_MESSAGE_REQUEST = "space.ship.sendMessageRequest";
export const ACCEPT_MESSAGE_REQUEST = "space.ship.acceptMessageRequest";
export const WITHDRAW_MESSAGE_REQUEST = "space.ship.withdrawMessageRequest";

const opaqueId = z.string().check(z.minLength(1), z.maxLength(128));
const socialId = z.string().check(z.minLength(1), z.maxLength(256));
const personName = z.string().check(z.minLength(1), z.maxLength(256));
const timestamp = z.int().check(z.positive());

/** The caller accepts an invitation this Ship issued, and becomes its contact. */
export type AcceptInvitationInput = {
  token: string;
  /** The accepting person's name, as the inviter will see it. */
  name: string;
};
/** The inviter's name comes back, since a private profile has no record to read it from. */
export type AcceptInvitationOutput = { name: string; generation: string; threadId: string };

export const acceptInvitationInputSchema = z.strictObject({
  token: z.string().check(z.minLength(1), z.maxLength(128)),
  name: personName,
}) satisfies z.ZodMiniType<AcceptInvitationInput>;
export const acceptInvitationOutputSchema = z.strictObject({
  name: personName,
  generation: opaqueId,
  threadId: opaqueId,
}) satisfies z.ZodMiniType<AcceptInvitationOutput>;

/** A message or contact update for a connected Ship; a repeated delivery ID is received once. */
export type DeliverInput = {
  deliveryId: string;
  /** The connection the delivery belongs to; a replaced connection refuses it. */
  generation: string;
  payload: FederationDeliveryPayload;
};
export type DeliverOutput = { state: "received" };

export const deliverInputSchema = z.strictObject({
  deliveryId: socialId,
  generation: opaqueId,
  payload: federationDeliveryPayloadSchema,
}) satisfies z.ZodMiniType<DeliverInput>;
export const deliverOutputSchema = z.strictObject({
  state: z.literal("received"),
}) satisfies z.ZodMiniType<DeliverOutput>;

/** A file a delivered message references; the response body carries it. */
export type GetAttachmentParams = { id: string };
export const getAttachmentParamsSchema = z.strictObject({
  id: z.string().check(z.regex(/^resource:[A-Za-z0-9_-]{1,119}$/)),
}) satisfies z.ZodMiniType<GetAttachmentParams>;

/** Someone who read this Ship's public profile asks to talk. */
export type SendMessageRequestInput = {
  requestId: string;
  /** The CID of the profile record its sender read. */
  profileCid: string;
  /** The sender's name, as the recipient will see it. */
  name: string;
  messageId: string;
  text: string;
  createdAtMs: number;
  expiresAtMs: number;
};
export type MessageRequestOutput = { state: "received" };

export const sendMessageRequestInputSchema = z.strictObject({
  requestId: opaqueId,
  profileCid: z.string().check(z.minLength(1), z.maxLength(128)),
  name: z.string().check(z.minLength(1), z.maxLength(80)),
  messageId: opaqueId,
  text: z.string().check(z.minLength(1), z.maxLength(32_768)),
  createdAtMs: timestamp,
  expiresAtMs: timestamp,
}) satisfies z.ZodMiniType<SendMessageRequestInput>;
export const messageRequestOutputSchema = z.strictObject({
  state: z.literal("received"),
}) satisfies z.ZodMiniType<MessageRequestOutput>;

/** The person a request went to accepts it; the caller, its recipient, becomes the sender's contact. */
export type AcceptMessageRequestInput = {
  requestId: string;
  /** The accepting person's name, as the sender will see it. */
  name: string;
};
export type AcceptMessageRequestOutput = { generation: string; threadId: string };

export const acceptMessageRequestInputSchema = z.strictObject({
  requestId: opaqueId,
  name: personName,
}) satisfies z.ZodMiniType<AcceptMessageRequestInput>;
export const acceptMessageRequestOutputSchema = z.strictObject({
  generation: opaqueId,
  threadId: opaqueId,
}) satisfies z.ZodMiniType<AcceptMessageRequestOutput>;

/** The sender withdraws a request it sent. */
export type WithdrawMessageRequestInput = { requestId: string };
export const withdrawMessageRequestInputSchema = z.strictObject({
  requestId: opaqueId,
}) satisfies z.ZodMiniType<WithdrawMessageRequestInput>;
