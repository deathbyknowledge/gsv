import type {
  ContactAliasSetArgs,
  ContactAliasSetResult,
  ContactDeliveryListArgs,
  ContactDeliveryListResult,
  ContactDeliveryRetryArgs,
  ContactDeliveryRetryResult,
  ContactDeliveryGetArgs,
  ContactDeliveryGetResult,
  ContactListArgs,
  ContactListResult,
  ContactNoticeDismissResult,
  ContactRequestCreateArgs,
  ContactRequestCreateResult,
  ContactRequestListArgs,
  ContactRequestListResult,
  ContactRequestRecord,
  ContactRequestUpdateArgs,
  ContactRequestUpdateResult,
  ContactRevokeArgs,
  ContactRevokeResult,
  ContactSendArgs,
  ContactSendResult,
  ConversationMessage,
  ConversationMessageAuthor,
  ConversationMessageOrigin,
  DeliverInput,
  DeliverOutput,
  FederationRequestDelivery,
  FsCopyEndpoint,
  FsReadArgs,
  FsReadResult,
  FsTransferSendArgs,
  JsonObject,
  JsonValue,
  OriginMessageRef,
  ResourceBlock,
  SocialMessageMetadata,
  SocialMessageProvenance,
} from "@humansandmachines/gsv/protocol";
import {
  ATTACHMENT_REVISION_HEADER,
  ATTACHMENT_SIZE_HEADER,
  contactDisplayName,
  DELIVER,
  deliverInputSchema,
  deliverOutputSchema,
  GET_ATTACHMENT,
  getAttachmentParamsSchema,
  originMessageRefSchema,
  jsonValueSchema,
  MAX_FEDERATION_MESSAGE_BYTES,
  MAX_FEDERATION_REQUEST_DETAILS_BYTES,
  MAX_FEDERATION_REQUEST_TITLE_BYTES,
  MAX_FEDERATION_RESOURCE_BYTES,
} from "@humansandmachines/gsv/protocol";
import * as z from "zod";
import type { FrameBody, ResponseOkFrame } from "../protocol/frames";
import { getConversationById } from "../shared/utils";
import { contactSendMessageId } from "@humansandmachines/gsv/protocol/stable-id";
import { stableOpaqueId } from "../shared/stable-id";
import {
  handleFsReadTransfer,
  handleFsTransferSend,
  type FsOpenedSource,
} from "../drivers/native/fs";
import { ensureShipDid } from "./atproto";
import type { KernelContext } from "./context";
import { kernelPeerContext } from "./peer";
import { ensurePersonalController } from "./personal-controller";
import {
  processMediaOwner,
  retainConversationResources,
} from "./conversation-handlers";
import {
  FederationRequestIdentityConflictError,
  type FederationContactRecord,
  type FederationInboxRecord,
  type FederationOutboxLocalMessage,
  type FederationOutboxRecord,
  type FederationPreparingOutboxRecord,
  type FederationReadyOutboxRecord,
  type FederationResourceGrant,
  isReadyFederationOutbox,
} from "./federation-store";
import { canonicalJson, sha256Base64Url } from "./federation-crypto";
import { revokeFederationContact } from "./federation/pairing";
import {
  assertContactReachable,
  contactSummary,
  requireContactCaller,
  requireContactHuman,
  requireOwnedContact,
  requireOwnedActiveContact,
  requireOwnedActiveContactGeneration,
} from "./federation/authority";
import { bindContactReply, admitContactMessage } from "./federation/attention";
import { PublicFederationError } from "./federation/errors";
import { checkContactWhenOpened, endContactIfShipGone, endContactsKnownGone } from "./federation/gone-ships";
import { ShipXrpcError } from "./ships/errors";
import { callShip, callShipProcedure, type ShipCall } from "./ships/xrpc";
import {
  assertDeliveryReplay,
  contactDeliveryStatus,
  contactSendResult,
  currentFederationDeliveryContact,
  deliveryRetryDelayMs,
  federationInputFingerprint,
  isTerminalFederationError,
  rearmPendingDelivery,
} from "./federation/delivery";
import {
  assertInboundCapacity,
  assertOutboundCapacity,
  assertRequestCapacity,
  consumeInboundDeliveryRate,
  consumeOutboundDeliveryRate,
  consumePublicRateLimits,
  pruneFederationState,
  MAX_DELIVERY_AGE_MS,
} from "./federation/limits";
import {
  assertRequestTransition,
  isRequestTransitionAllowed,
  requestWireRecord,
  syncFederationRequestResponsibility,
} from "./federation/requests";
import {
  assertResourceGrantCapacity,
  createResourceGrant,
  federationContactStream,
  isCurrentFederationContact,
  isCurrentFederationResource,
  localizeResource,
  validateFederationResourceDescriptors,
  validateFederationResources,
} from "./federation/resources";

const MAX_CONTACT_DISPLAY_NAME_BYTES = 256;
const MAX_RESOURCE_READS_PER_CONTACT_PER_MINUTE = 240;
const MAX_RESOURCE_READS_PER_INSTALLATION_PER_MINUTE = 1_000;
const MAX_CONCURRENT_RESOURCE_READS_PER_CONTACT = 8;
const RESOURCE_READ_LEASE_MS = 15 * 60_000;
/** How long reading a contact's attachment may take, body included. */
const ATTACHMENT_READ_TIMEOUT_MS = 120_000;
const RATE_WINDOW_MS = 60_000;
/** When a Ship still accepting a connection asks the other Ship to deliver again. */
const ACCEPTING_RETRY_MS = 30_000;
export const MAX_FEDERATION_RECOVERABLE_OUTBOX = 1_500;
export const MAX_FEDERATION_RECOVERABLE_INBOX = 250;
export const FEDERATION_INBOX_RECOVERY_RETRY_MS = 30_000;
const MAX_DELIVERY_ATTEMPTS = 12;
/** What a contact's Ship hears once its delivery is received; a repeated delivery hears it again. */
const RECEIVED: DeliverOutput = { state: "received" };
const encoder = new TextEncoder();

export async function handleContactList(
  args: ContactListArgs,
  ctx: KernelContext,
): Promise<ContactListResult> {
  const ownerUid = requireContactCaller(ctx, false);
  await endContactsKnownGone(ownerUid, ctx);
  return {
    contacts: ctx.federation.list(ownerUid, args.includeRevoked ?? false).map(contactSummary),
    attentionNotice: ctx.federation.attentionNotice(ownerUid),
  };
}

export function handleContactNoticeDismiss(ctx: KernelContext): ContactNoticeDismissResult {
  const ownerUid = requireContactHuman(ctx);
  if (ctx.federation.dismissAttentionNotice(ownerUid)) ctx.broadcastToUserUid(ownerUid, "contact.changed");
  return {};
}

export function handleContactAliasSet(
  args: ContactAliasSetArgs,
  ctx: KernelContext,
): ContactAliasSetResult {
  const ownerUid = requireContactCaller(ctx, true);
  const contact = requireOwnedContact(args.contactId, ownerUid, ctx);
  const alias = args.alias === null
    ? null
    : boundedText(args.alias.trim(), "Contact alias", MAX_CONTACT_DISPLAY_NAME_BYTES, false);
  const updated = ctx.federation.setAlias(contact.id, ownerUid, alias);
  ctx.conversations.setTitle(updated.conversationId, contactDisplayName(updated));
  if (contact.localAlias !== updated.localAlias) ctx.broadcastToUserUid(ownerUid, "contact.changed");
  return { contact: contactSummary(updated) };
}

export async function handleContactRevoke(
  args: ContactRevokeArgs,
  ctx: KernelContext,
): Promise<ContactRevokeResult> {
  const ownerUid = requireContactCaller(ctx, true);
  pruneFederationState(ctx, Date.now());
  const contact = requireOwnedContact(args.contactId, ownerUid, ctx);
  return await ctx.coordinateFederationContact(contact.id, async () => {
    const current = requireOwnedContact(contact.id, ownerUid, ctx);
    const idempotencyKey = `contact.revoke:${current.id}:${current.generation}`;
    const fingerprint = await federationInputFingerprint({
      operation: "contact.revoke",
      contactId: current.id,
      generation: current.generation,
    });
    const existing = ctx.federation.outboxByIdempotency(ownerUid, idempotencyKey);
    if (existing) {
      assertDeliveryReplay(existing, current.id, current.generation, fingerprint);
      await rearmPendingDelivery(existing, ctx);
      await ctx.reconcileResponsibilityWake(ownerUid);
      return { contact: contactSummary(ctx.federation.get(current.id)!) };
    }
    if (current.state === "revoked") {
      await ctx.reconcileResponsibilityWake(ownerUid);
      return { contact: contactSummary(current) };
    }
    assertContactReachable(current);
    const deliveryId = `delivery:${crypto.randomUUID()}`;
    const revokedAtMs = Date.now();
    ctx.federation.transaction(() => {
      ctx.federation.terminatePendingForRevokedContact(
        current.id,
        current.generation,
        null,
        revokedAtMs,
      );
      ctx.federation.enqueue({
        deliveryId,
        ownerUid,
        contactId: current.id,
        contactGeneration: current.generation,
        idempotencyKey,
        fingerprint,
        payload: { kind: "contact.revoked" },
        now: revokedAtMs,
      });
      revokeFederationContact(current, revokedAtMs, ctx);
    });
    ctx.broadcastToUserUid(ownerUid, "contact.changed");
    await ctx.scheduleFederationDelivery(deliveryId, Date.now(), true);
    await ctx.reconcileResponsibilityWake(ownerUid);
    return { contact: contactSummary(ctx.federation.get(current.id)!) };
  });
}

export async function handleContactSend(
  args: ContactSendArgs,
  ctx: KernelContext,
): Promise<ContactSendResult> {
  const ownerUid = requireContactCaller(ctx, false);
  const now = Date.now();
  pruneFederationState(ctx, now);
  const idempotencyKey = normalizeIdempotencyKey(args.idempotencyKey);
  const text = boundedText(
    args.text,
    "Contact message",
    MAX_FEDERATION_MESSAGE_BYTES,
    true,
  );
  const requestedMedia = validateFederationResources(args.media);
  if (!text.trim() && !requestedMedia?.length) {
    throw new Error("Contact message requires text or a resource");
  }
  const contact = requireOwnedActiveContact(args.contactId, ownerUid, ctx);
  const replyTo = args.replyTo ? originMessageRefSchema.parse(args.replyTo) : undefined;
  const fingerprint = await federationInputFingerprint(jsonValue({
    operation: "contact.send",
    contactId: contact.id,
    text,
    media: requestedMedia ?? [],
    ...(replyTo ? { replyTo } : undefined),
    ...(args.responsibilityId ? { responsibilityId: args.responsibilityId } : undefined),
  }));
  const existing = ctx.federation.outboxByIdempotency(ownerUid, idempotencyKey);
  if (existing) {
    const replayContact = requireOwnedActiveContactGeneration(contact, ownerUid, ctx);
    assertDeliveryReplay(
      existing,
      replayContact.id,
      replayContact.generation,
      fingerprint,
    );
    await rearmPendingDelivery(existing, ctx);
    const replay = existing.state === "preparing"
      ? await advanceFederationMessagePreparationOrRecordFailure(existing, ctx)
      : existing;
    ctx.requestSignal?.throwIfAborted();
    return contactSendResult(replay, replayContact);
  }
  assertOutboundCapacity(ownerUid, contact.id, ctx, now);
  if (replyTo && !await getConversationById(ctx.installationId, contact.conversationId).resolveOrigin(replyTo, contact.threadId)) {
    throw new Error("Reply must reference a message in this contact conversation");
  }
  const processId = requestedMedia?.length ? await ensurePersonalController(ownerUid, ctx) : undefined;
  // Media is persisted under the handler's archive, so only the handler and
  // the work it delegated may attach it. Reject here so a delegated child
  // learns at send time instead of after every background retry fails.
  if (
    requestedMedia?.length
    && processId
    && ctx.processId
    && ctx.processId !== processId
    && !ctx.procs.isDescendant(ctx.processId, processId)
  ) {
    throw new Error(
      "Contact media can only be attached by the conversation handler process or one of its subprocesses",
    );
  }
  ctx.requestSignal?.throwIfAborted();
  const did = await ensureShipDid(ctx);
  const deliveryId = `delivery:${crypto.randomUUID()}`;
  const messageId = await contactSendMessageId(contact.id, contact.generation, idempotencyKey);
  const localMessage = localOutboundMessage({
    messageId,
    text,
    handlerPid: processId,
    ownerUid,
    contact,
    deliveryId,
    did,
    replyTo,
    ctx,
    now,
  });
  ctx.requestSignal?.throwIfAborted();
  const admitted = await ctx.coordinateFederationContact(contact.id, () => ctx.federation.transaction(() => {
    ctx.requestSignal?.throwIfAborted();
    const admittedContact = requireOwnedActiveContactGeneration(contact, ownerUid, ctx);
    const concurrent = ctx.federation.outboxByIdempotency(ownerUid, idempotencyKey);
    if (concurrent) {
      assertDeliveryReplay(
        concurrent,
        admittedContact.id,
        admittedContact.generation,
        fingerprint,
      );
      return concurrent;
    }
    assertOutboundCapacity(ownerUid, admittedContact.id, ctx, now);
    consumeOutboundDeliveryRate(ownerUid, admittedContact.id, ctx, now);
    assertResourceGrantCapacity(admittedContact.id, requestedMedia?.length ?? 0, ctx);
    if (args.responsibilityId) bindContactReply(admittedContact, localMessage, args.responsibilityId, ctx);
    return ctx.federation.prepareMessage({
      deliveryId,
      ownerUid,
      contactId: admittedContact.id,
      contactGeneration: admittedContact.generation,
      idempotencyKey,
      fingerprint,
      preparation: {
        kind: "message",
        messageId,
        threadId: admittedContact.threadId,
        text,
        resources: requestedMedia ?? [],
        localMessage,
      },
      now,
    }).record;
  }));
  await ctx.scheduleFederationDelivery(admitted.deliveryId, now, true);
  const record = admitted.state === "preparing"
    ? await advanceFederationMessagePreparationOrRecordFailure(admitted, ctx)
    : admitted;
  ctx.requestSignal?.throwIfAborted();
  return contactSendResult(record, contact);
}

export function handleContactDeliveryList(args: ContactDeliveryListArgs, ctx: KernelContext): ContactDeliveryListResult {
  const ownerUid = requireContactCaller(ctx, false);
  const contact = requireOwnedContact(args.contactId, ownerUid, ctx);
  const { deliveryIds, messageSequences } = z.object({
    deliveryIds: z.array(z.string().startsWith("delivery:").max(256)).max(100).default([]),
    messageSequences: z.array(z.number().int().positive()).max(100).default([]),
  }).parse(args);
  if (deliveryIds.length + messageSequences.length > 100) {
    throw new Error("Select at most 100 delivery identities or message sequences");
  }
  const deliveries = ctx.federation.listDeliveries(ownerUid, contact.id, deliveryIds, messageSequences)
    .map((record) => contactDeliveryStatus(record, contact));
  checkContactWhenOpened(contact, ctx);
  return { deliveries };
}

export async function handleContactDeliveryRetry(args: ContactDeliveryRetryArgs, ctx: KernelContext): Promise<ContactDeliveryRetryResult> {
  const ownerUid = requireContactCaller(ctx, true);
  if (!Number.isSafeInteger(args.expectedUpdatedAtMs) || args.expectedUpdatedAtMs < 0) {
    throw new Error("Delivery revision is invalid");
  }
  const now = Date.now();
  const retried = ctx.federation.transaction(() => {
    const record = ctx.federation.outbox(args.deliveryId);
    if (!record || record.ownerUid !== ownerUid) throw new Error("Delivery not found");
    const contact = requireOwnedActiveContact(record.contactId, ownerUid, ctx);
    if (contact.generation !== record.contactGeneration || !record.retryable
      || record.updatedAtMs !== args.expectedUpdatedAtMs || now - record.createdAtMs >= MAX_DELIVERY_AGE_MS) {
      throw new Error("This delivery cannot be retried; review its current state");
    }
    if (isReadyFederationOutbox(record) && record.payload.kind !== "message") {
      throw new Error("Only a message can use delivery retry");
    }
    assertOutboundCapacity(ownerUid, contact.id, ctx, now, true);
    consumeOutboundDeliveryRate(ownerUid, contact.id, ctx, now);
    if (!isReadyFederationOutbox(record)) assertResourceGrantCapacity(contact.id, record.preparation.resources.length, ctx);
    return { record: ctx.federation.retryMessage(record, now), contact };
  });
  ctx.broadcastToUserUid(ownerUid, "contact.delivery.changed", { contactId: retried.contact.id });
  await ctx.scheduleFederationDelivery(retried.record.deliveryId, now, false);
  const record = retried.record.state === "preparing"
    ? await advanceFederationMessagePreparationOrRecordFailure(retried.record, ctx) : retried.record;
  return contactSendResult(record, retried.contact);
}

export function handleContactDeliveryGet(
  args: ContactDeliveryGetArgs,
  ctx: KernelContext,
): ContactDeliveryGetResult {
  const ownerUid = requireContactCaller(ctx, false);
  const deliveryId = args.deliveryId.trim();
  if (!deliveryId.startsWith("delivery:") || deliveryId.length > 256) {
    throw new Error("Contact delivery id is invalid");
  }
  const record = ctx.federation.outbox(deliveryId);
  if (!record || record.ownerUid !== ownerUid) return { delivery: null };
  const contact = ctx.federation.get(record.contactId);
  if (!contact || contact.ownerUid !== ownerUid) return { delivery: null };
  return { delivery: contactDeliveryStatus(record, contact) };
}

export function handleContactRequestList(
  args: ContactRequestListArgs,
  ctx: KernelContext,
): ContactRequestListResult {
  const ownerUid = requireContactCaller(ctx, false);
  return {
    requests: ctx.federation.listRequests(
      ownerUid,
      args.contactId,
      args.includeTerminal ?? false,
    ),
  };
}

export async function handleContactRequestCreate(
  args: ContactRequestCreateArgs,
  ctx: KernelContext,
): Promise<ContactRequestCreateResult> {
  const ownerUid = requireContactCaller(ctx, false);
  const now = Date.now();
  pruneFederationState(ctx, now);
  const idempotencyKey = normalizeIdempotencyKey(args.idempotencyKey);
  const contact = requireOwnedActiveContact(args.contactId, ownerUid, ctx);
  const kind = boundedIdentifier(args.kind, "Request kind");
  const title = boundedText(
    args.title,
    "Request title",
    MAX_FEDERATION_REQUEST_TITLE_BYTES,
    false,
  );
  const details = args.details ? boundedDetails(args.details) : undefined;
  const fingerprint = await federationInputFingerprint(jsonValue({
    operation: "contact.request.create",
    contactId: contact.id,
    kind,
    title,
    ...(details ? { details } : undefined),
  }));
  const existing = ctx.federation.outboxByIdempotency(ownerUid, idempotencyKey);
  if (existing) {
    if (!isReadyFederationOutbox(existing) || existing.payload.kind !== "request") {
      throw new Error("Contact request idempotency key was used for another delivery");
    }
    const replayContact = requireOwnedActiveContactGeneration(contact, ownerUid, ctx);
    assertDeliveryReplay(
      existing,
      replayContact.id,
      replayContact.generation,
      fingerprint,
    );
    await rearmPendingDelivery(existing, ctx);
    const request = ctx.federation.request(existing.payload.request.id);
    if (!request) throw new Error("Contact request delivery is missing its local request");
    return { request, deliveryId: existing.deliveryId };
  }
  assertOutboundCapacity(ownerUid, contact.id, ctx, now);
  assertRequestCapacity(contact.id, ctx);
  const deliveryId = `delivery:${crypto.randomUUID()}`;
  const request: ContactRequestRecord = {
    id: `request:${crypto.randomUUID()}`,
    contactId: contact.id,
    contactGeneration: contact.generation,
    direction: "outgoing",
    kind,
    title,
    ...(details ? { details } : undefined),
    state: "offered",
    revision: 1,
    exchange: { state: "pending", source: "local", deliveryId },
    createdAtMs: now,
    updatedAtMs: now,
  };
  const payload: FederationRequestDelivery = {
    kind: "request",
    request: requestWireRecord(request),
  };
  ctx.federation.transaction(() => {
    const admittedContact = requireOwnedActiveContactGeneration(contact, ownerUid, ctx);
    assertOutboundCapacity(ownerUid, admittedContact.id, ctx, now);
    consumeOutboundDeliveryRate(ownerUid, admittedContact.id, ctx, now);
    assertRequestCapacity(admittedContact.id, ctx);
    const created = ctx.federation.createRequest(request);
    syncFederationRequestResponsibility({
      request: created,
      contact: admittedContact,
      conversationId: admittedContact.conversationId,
      deliveryId,
      remoteInput: false,
      createAllowed: true,
      now,
    }, ctx);
    ctx.federation.enqueue({
      deliveryId,
      ownerUid,
      contactId: admittedContact.id,
      contactGeneration: admittedContact.generation,
      idempotencyKey,
      fingerprint,
      payload,
      now,
    });
  });
  ctx.broadcastToUserUid(ownerUid, "contact.request.changed", { contactId: contact.id });
  await ctx.scheduleFederationDelivery(deliveryId, now, true);
  await ctx.reconcileResponsibilityWake(ownerUid);
  return { request: ctx.federation.request(request.id)!, deliveryId };
}

export async function handleContactRequestUpdate(
  args: ContactRequestUpdateArgs,
  ctx: KernelContext,
): Promise<ContactRequestUpdateResult> {
  const ownerUid = requireContactCaller(ctx, false);
  const now = Date.now();
  pruneFederationState(ctx, now);
  const idempotencyKey = normalizeIdempotencyKey(args.idempotencyKey);
  const details = args.details ? boundedDetails(args.details) : undefined;
  const fingerprint = await federationInputFingerprint(jsonValue({
    operation: "contact.request.update",
    requestId: args.requestId,
    expectedRevision: args.expectedRevision ?? null,
    state: args.state,
    ...(details ? { details } : undefined),
  }));
  const existing = ctx.federation.outboxByIdempotency(ownerUid, idempotencyKey);
  if (existing) {
    if (!isReadyFederationOutbox(existing) || existing.payload.kind !== "request.update") {
      throw new Error("Contact request idempotency key was used for another delivery");
    }
    const request = ctx.federation.request(args.requestId);
    if (!request) throw new Error(`Contact request not found: ${args.requestId}`);
    assertDeliveryReplay(
      existing,
      request.contactId,
      request.contactGeneration,
      fingerprint,
    );
    await rearmPendingDelivery(existing, ctx);
    return { request, deliveryId: existing.deliveryId };
  }
  const current = ctx.federation.request(args.requestId);
  if (!current) throw new Error(`Contact request not found: ${args.requestId}`);
  const contact = requireOwnedActiveContact(current.contactId, ownerUid, ctx);
  if (contact.generation !== current.contactGeneration) {
    throw new Error("Contact request belongs to a superseded pairing");
  }
  const expectedRevision = args.expectedRevision ?? current.revision;
  if (expectedRevision !== current.revision) throw new Error("Contact request revision changed");
  assertRequestTransition(current, args.state);
  assertOutboundCapacity(ownerUid, contact.id, ctx, now);
  const deliveryId = `delivery:${crypto.randomUUID()}`;
  const wireRequestId = current.direction === "incoming"
    ? current.remoteId
    : current.id;
  if (!wireRequestId) throw new Error("Incoming contact request has no remote identity");
  const updated = ctx.federation.transaction(() => {
    assertOutboundCapacity(ownerUid, contact.id, ctx, now);
    consumeOutboundDeliveryRate(ownerUid, contact.id, ctx, now);
    const next = ctx.federation.updateRequest({
      requestId: current.id,
      expectedRevision,
      state: args.state,
      exchange: { state: "pending", source: "local", deliveryId },
      details,
      updatedAtMs: now,
    });
    syncFederationRequestResponsibility({
      request: next,
      contact,
      conversationId: contact.conversationId,
      deliveryId,
      remoteInput: false,
      createAllowed: current.direction === "outgoing" || args.state === "accepted" || args.state === "active",
      now,
    }, ctx);
    ctx.federation.enqueue({
      deliveryId,
      ownerUid,
      contactId: contact.id,
      contactGeneration: contact.generation,
      idempotencyKey,
      fingerprint,
      payload: {
        kind: "request.update",
        requestId: wireRequestId,
        expectedRevision,
        state: args.state,
        ...(details ? { details } : undefined),
      },
      now,
    });
    return next;
  });
  ctx.broadcastToUserUid(ownerUid, "contact.request.changed", { contactId: contact.id });
  await ctx.scheduleFederationDelivery(deliveryId, now, true);
  await ctx.reconcileResponsibilityWake(ownerUid);
  return { request: updated, deliveryId };
}

export async function processFederationDelivery(
  deliveryId: string,
  ctx: KernelContext,
): Promise<void> {
  let record = ctx.federation.outbox(deliveryId);
  if (!record) return;
  if (record.state === "preparing") {
    record = await advanceFederationMessagePreparationOrRecordFailure(record, ctx);
  }
  if (!isReadyFederationOutbox(record) || record.state !== "pending") return;
  const contact = currentFederationDeliveryContact(record, ctx);
  if (!contact) {
    await recordFederationOutboxFailure(
      record,
      new Error("Contact is no longer active"),
      ctx,
    );
    return;
  }

  try {
    await commitLocalOutboxMessage(record, contact, ctx);
    if (!currentFederationDeliveryContact(record, ctx)) return;
    assertContactReachable(contact);
    const input: DeliverInput = { deliveryId: record.deliveryId, generation: record.contactGeneration, payload: record.payload };
    deliverOutputSchema.parse(await callShipProcedure(contact.remoteDid, DELIVER, jsonValue(input), ctx));
    const committedAtMs = Date.now();
    let requestChanged = false;
    const committed = ctx.federation.transaction(() => {
      if (!ctx.federation.markDeliverySucceeded(
        deliveryId,
        record.contactGeneration,
        committedAtMs,
        record.retryEpoch,
      )) {
        return false;
      }
      if (!ctx.federation.markContactDelivered(
        contact.id,
        record.contactGeneration,
        committedAtMs,
      )) {
        throw new Error("Contact generation changed during delivery completion");
      }
      requestChanged = syncRequestDeliveryOutcome(record, ctx);
      return true;
    });
    if (!committed) return;
    ctx.broadcastToUserUid(record.ownerUid, "contact.delivery.changed", { contactId: record.contactId });
    if (requestChanged) {
      ctx.broadcastToUserUid(record.ownerUid, "contact.request.changed", { contactId: record.contactId });
      await ctx.reconcileResponsibilityWake(record.ownerUid);
    }
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    if (await endContactIfShipGone(contact, failure, ctx)) return;
    await recordFederationOutboxFailure(record, failure, ctx);
  }
}

async function advanceFederationMessagePreparationOrRecordFailure(
  record: FederationPreparingOutboxRecord,
  ctx: KernelContext,
): Promise<FederationOutboxRecord> {
  try {
    return await advanceFederationMessagePreparation(record, ctx);
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    await recordFederationOutboxFailure(record, failure, ctx);
    return ctx.federation.outbox(record.deliveryId) ?? record;
  }
}

async function advanceFederationMessagePreparation(
  record: FederationPreparingOutboxRecord,
  ctx: KernelContext,
): Promise<FederationOutboxRecord> {
  if (record.state !== "preparing") return record;
  const processId = record.preparation.resources.length > 0
    ? await ensurePersonalController(record.ownerUid, ctx) : undefined;
  const retained = processId
    ? await retainConversationResources(record.preparation.resources, processId, ctx, record.deliveryId) ?? []
    : [];
  if (retained.length !== record.preparation.resources.length) {
    throw new Error("Personal intelligence retained an incomplete resource batch");
  }
  const now = Date.now();
  return ctx.federation.transaction(() => {
    const current = ctx.federation.outbox(record.deliveryId);
    if (!current) throw new Error("Contact message preparation disappeared");
    if (current.state !== "preparing" || current.retryEpoch !== record.retryEpoch) return current;
    const contact = currentFederationDeliveryContact(current, ctx);
    if (!contact) throw new Error("Contact is no longer active");
    const resources = retained.map((resource) => createResourceGrant(
      contact,
      current.ownerUid,
      resource,
      ctx,
      now,
    ));
    const localMessage: FederationOutboxLocalMessage = {
      ...current.preparation.localMessage,
      ...(resources.length ? { media: retained } : undefined),
      ...(current.preparation.localMessage.author.kind === "user" && processId
        ? { processId }
        : undefined),
    };
    return ctx.federation.completeMessagePreparation({
      deliveryId: current.deliveryId,
      contactGeneration: current.contactGeneration,
      payload: {
        kind: "message",
        messageId: current.preparation.messageId,
        threadId: current.preparation.threadId,
        text: current.preparation.text,
        social: localMessage.social,
        ...(resources.length ? { resources } : undefined),
      },
      localMessage,
      now,
    });
  });
}

async function recordFederationOutboxFailure(
  record: FederationOutboxRecord,
  error: Error,
  ctx: KernelContext,
): Promise<void> {
  if (record.state !== "preparing" && record.state !== "pending") return;
  const latest = ctx.federation.outbox(record.deliveryId);
  if (
    !latest
    || latest.state !== record.state
    || latest.contactGeneration !== record.contactGeneration
    || latest.retryEpoch !== record.retryEpoch
  ) {
    return;
  }
  // A removal stays owed to the contact it ended, so it retries like any delivery.
  const contact = currentFederationDeliveryContact(record, ctx);
  const contactActive = contact?.state === "active";
  const attempt = latest.attemptCount + 1;
  const terminal = !contact
    || attempt >= MAX_DELIVERY_ATTEMPTS
    || Date.now() - record.createdAtMs >= MAX_DELIVERY_AGE_MS
    || isTerminalFederationError(error);
  const retryAt = terminal ? null : Date.now() + deliveryRetryDelayMs(attempt);
  const message = error.message;
  const expectedState = record.state;
  let requestChanged = false;
  const recorded = ctx.federation.transaction(() => {
    if (!ctx.federation.markOutboxFailed(
      record.deliveryId,
      record.contactGeneration,
      expectedState,
      message,
      retryAt,
      terminal,
      Date.now(),
      contactActive && (!isReadyFederationOutbox(record) || record.payload.kind === "message")
        && Date.now() - record.createdAtMs < MAX_DELIVERY_AGE_MS && !isTerminalFederationError(error),
      record.retryEpoch,
    )) return false;
    if (isReadyFederationOutbox(record)) requestChanged = syncRequestDeliveryOutcome(record, ctx);
    return true;
  });
  if (!recorded) return;
  ctx.broadcastToUserUid(record.ownerUid, "contact.delivery.changed", { contactId: record.contactId });
  if (requestChanged) {
    ctx.broadcastToUserUid(record.ownerUid, "contact.request.changed", { contactId: record.contactId });
    await ctx.reconcileResponsibilityWake(record.ownerUid);
  }
  if (terminal) {
    const local = isReadyFederationOutbox(record) ? record.localMessage : record.preparation.localMessage;
    if (contactActive && (local?.author.kind === "process" || isReadyFederationOutbox(record) && record.payload.kind !== "message")) {
      createDeliveryDebtResponsibility(record, message, ctx);
      await ctx.reconcileResponsibilityWake(record.ownerUid);
    }
    return;
  }
  await ctx.scheduleFederationDelivery(record.deliveryId, retryAt!, false);
}

function syncRequestDeliveryOutcome(
  record: FederationReadyOutboxRecord,
  ctx: KernelContext,
): boolean {
  if (record.payload.kind !== "request" && record.payload.kind !== "request.update") return false;
  const latest = ctx.federation.outbox(record.deliveryId);
  const contact = currentFederationDeliveryContact(record, ctx);
  if (!latest || !isReadyFederationOutbox(latest) || !contact) return false;
  const request = ctx.federation.settleRequestDelivery(latest);
  if (!request) return false;
  syncFederationRequestResponsibility({
    request,
    contact,
    conversationId: contact.conversationId,
    deliveryId: record.deliveryId,
    remoteInput: false,
    createAllowed: false,
    now: Date.now(),
  }, ctx);
  return true;
}

export async function handleContactResourceSend(
  args: FsTransferSendArgs,
  ctx: KernelContext,
  frameId: string,
): Promise<ResponseOkFrame<"fs.transfer.send">> {
  const ownerUid = requireContactCaller(ctx, false);
  const target = args.target?.trim() ?? "";
  if (!target.startsWith("contact:") || target.length <= "contact:".length) {
    throw new Error("Contact resource target is invalid");
  }
  const contact = requireOwnedActiveContact(target, ownerUid, ctx);
  const resourceId = decodeLocalResourcePath(args.path);
  const response = await callShip(contact.remoteDid, GET_ATTACHMENT, { params: { id: resourceId }, timeoutMs: ATTACHMENT_READ_TIMEOUT_MS }, ctx);
  if (!isCurrentFederationContact(contact.id, contact.generation, ctx)) {
    await response.body?.cancel("Contact generation changed during resource read").catch(() => {});
    throw new Error("Contact generation changed during resource read");
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Remote resource request failed (${response.status})`);
  }
  const size = parseResourceSize(response.headers.get(ATTACHMENT_SIZE_HEADER));
  if (size > MAX_FEDERATION_RESOURCE_BYTES) {
    await response.body.cancel("Remote resource exceeds the federation limit").catch(() => {});
    throw new Error(`Remote resource exceeds ${MAX_FEDERATION_RESOURCE_BYTES} bytes`);
  }
  const revision = response.headers.get(ATTACHMENT_REVISION_HEADER) ?? "";
  const contentType = response.headers.get("content-type") ?? "application/octet-stream";
  if (args.revision && args.revision !== revision) {
    await response.body.cancel("Remote resource revision changed").catch(() => {});
    throw new Error("Remote resource revision is no longer available");
  }
  return {
    type: "res",
    id: frameId,
    ok: true,
    data: {
      ok: true,
      path: args.path,
      size,
      contentType,
      revision,
    },
    body: {
      stream: federationContactStream(
        response.body,
        () => isCurrentFederationContact(contact.id, contact.generation, ctx),
      ),
      length: size,
    },
  };
}

export async function handleContactResourceRead(
  args: FsReadArgs,
  ctx: KernelContext,
  frameId: string,
): Promise<{ data: FsReadResult; body?: FrameBody }> {
  try {
    const transfer = await handleContactResourceSend({
      target: args.target,
      path: args.path,
    }, ctx, frameId);
    return await handleFsReadTransfer(args, transfer, ctx);
  } catch (error) {
    return {
      data: { ok: false, error: error instanceof Error ? error.message : String(error) },
    };
  }
}

export async function openContactResourceSource(
  source: Required<FsCopyEndpoint>,
  ctx: KernelContext,
): Promise<FsOpenedSource> {
  const response = await handleContactResourceSend({
    target: source.target,
    path: source.path,
  }, ctx, crypto.randomUUID());
  const result = response.data;
  if (!result) {
    await response.body?.stream.cancel("Contact resource transfer returned no response data").catch(() => {});
    throw new Error("Contact resource transfer returned no response data");
  }
  if (!result.ok) {
    await response.body?.stream.cancel(result.error).catch(() => {});
    throw new Error(result.error);
  }
  if (!response.body) throw new Error("Contact resource transfer returned no response body");
  if (response.body.length !== undefined && response.body.length !== result.size) {
    await response.body.stream.cancel("Remote resource size did not match its metadata").catch(() => {});
    throw new Error("Remote resource size did not match its metadata");
  }
  return {
    body: response.body,
    size: result.size,
    contentType: result.contentType,
  };
}

/** `space.ship.deliver`: a contact's Ship delivers a message or contact update, received once per delivery ID. */
export async function deliver(call: ShipCall, ctx: KernelContext): Promise<DeliverOutput> {
  const { deliveryId, generation, payload } = deliverInputSchema.parse(call.input);
  const contact = ctx.federation.getByCaller(call.caller);
  if (
    !contact
    || contact.generation !== generation
    || (contact.state !== "active" && payload.kind !== "contact.revoked")
  ) {
    // The other Ship records a connection before this one does, so a delivery can arrive while this Ship is still accepting it.
    if (ctx.federation.pairingPending(call.caller) || ctx.approaches.accepting(call.caller)) {
      throw new ShipXrpcError(503, "TemporarilyUnavailable", "This Ship is still accepting the connection", ACCEPTING_RETRY_MS);
    }
    throw new PublicFederationError(404, "Contact not found");
  }
  const payloadHash = await sha256Base64Url(canonicalJson(jsonValue(payload)));
  await ctx.coordinateFederationInbound(
    `${contact.id}:${generation}:${deliveryId}`,
    async () => await ctx.coordinateFederationContact(contact.id, async () => {
      const currentContact = ctx.federation.get(contact.id);
      if (
        !currentContact
        || currentContact.generation !== generation
        || (currentContact.state !== "active" && payload.kind !== "contact.revoked")
      ) {
        throw new PublicFederationError(404, "Contact not found");
      }
      const now = Date.now();
      pruneFederationState(ctx, now);
      const existing = ctx.federation.inbox(currentContact.id, generation, deliveryId);
      if (currentContact.state !== "active" && (payload.kind !== "contact.revoked" || !existing)) {
        throw new PublicFederationError(404, "Contact not found");
      }
      if (existing && existing.payloadHash !== payloadHash) {
        throw new PublicFederationError(409, "Federation delivery id was reused");
      }
      const received = existing ?? ctx.federation.transaction(() => {
        if (payload.kind !== "contact.revoked") {
          if (ctx.auth.isAccountDisabled(currentContact.ownerUid)) {
            const request = payload.kind === "request.update"
              ? ctx.federation.requestForRemoteUpdate(currentContact.id, currentContact.generation, payload.requestId)
              : null;
            if (payload.kind !== "request.update" || !request
              || request.revision !== payload.expectedRevision
              || !isRequestTransitionAllowed(request, payload.state, "remote")) {
              throw new PublicFederationError(404, "Contact not found");
            }
          }
          assertInboundCapacity(currentContact, payload, ctx, now);
          consumeInboundDeliveryRate(currentContact, ctx, now);
        }
        return ctx.federation.receive({
          contactId: currentContact.id,
          contactGeneration: generation,
          deliveryId,
          payloadHash,
          payload,
          now,
        }).record;
      });
      if (received.state === "committed") return;
      if (received.state === "rejected") {
        throw new PublicFederationError(409, "Federation delivery was rejected");
      }
      try {
        await projectInboundDelivery(received, currentContact, ctx);
      } catch (error) {
        if (ctx.federation.inbox(currentContact.id, generation, deliveryId)?.state === "received") {
          try {
            await ctx.scheduleFederationInbox(
              currentContact.id,
              generation,
              deliveryId,
              Date.now() + FEDERATION_INBOX_RECOVERY_RETRY_MS,
              true,
            );
          } catch (scheduleError) {
            throw new AggregateError(
              [error, scheduleError],
              `Federation inbox ${deliveryId} failed and could not be requeued`,
            );
          }
        }
        throw error;
      }
    }),
  );
  return RECEIVED;
}

export async function recoverFederationInbox(
  contactId: string,
  contactGeneration: string,
  deliveryId: string,
  ctx: KernelContext,
): Promise<void> {
  const pending = ctx.federation.inbox(contactId, contactGeneration, deliveryId);
  if (!pending || pending.state !== "received") return;
  await ctx.coordinateFederationInbound(
    `${contactId}:${contactGeneration}:${deliveryId}`,
    async () => await ctx.coordinateFederationContact(contactId, async () => {
      const inbox = ctx.federation.inbox(contactId, contactGeneration, deliveryId);
      if (!inbox) throw new PublicFederationError(404, "Federation delivery not found");
      if (inbox.state === "committed") return;
      if (inbox.state === "rejected") {
        throw new PublicFederationError(409, "Federation delivery was rejected");
      }
      const contact = ctx.federation.get(contactId);
      if (
        !contact
        || contact.generation !== contactGeneration
        || (contact.state !== "active" && inbox.payload.kind !== "contact.revoked")
      ) {
        ctx.federation.rejectInbox(
          contactId,
          contactGeneration,
          deliveryId,
          "Contact is no longer active",
        );
        throw new PublicFederationError(404, "Contact not found");
      }
      await projectInboundDelivery(inbox, contact, ctx);
    }),
  );
}

async function projectInboundDelivery(
  inbox: FederationInboxRecord,
  contact: FederationContactRecord,
  ctx: KernelContext,
): Promise<void> {
  try {
    await commitInboundDelivery(inbox, contact, ctx);
    const committedAtMs = Date.now();
    if (!ctx.federation.commitInbox(
      contact.id,
      inbox.contactGeneration,
      inbox.deliveryId,
      committedAtMs,
    )) {
      throw new PublicFederationError(409, "Federation delivery is no longer admissible");
    }
    ctx.federation.markContactReceived(
      contact.id,
      inbox.contactGeneration,
      committedAtMs,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      error instanceof PublicFederationError
      && error.status >= 400
      && error.status < 500
      && error.status !== 408
      && error.status !== 429
    ) {
      ctx.federation.rejectInbox(
        contact.id,
        inbox.contactGeneration,
        inbox.deliveryId,
        message,
      );
    } else {
      ctx.federation.failInbox(
        contact.id,
        inbox.contactGeneration,
        inbox.deliveryId,
        message,
      );
    }
    throw error;
  }
}

async function commitInboundDelivery(
  inbox: FederationInboxRecord,
  contact: FederationContactRecord,
  ctx: KernelContext,
): Promise<void> {
  switch (inbox.payload.kind) {
    case "message":
      await commitInboundMessage(inbox, contact, ctx);
      return;
    case "request":
      await commitInboundRequest(inbox, contact, ctx);
      return;
    case "request.update":
      await commitInboundRequestUpdate(inbox, contact, ctx);
      return;
    case "contact.revoked":
      const receivedAtMs = Date.now();
      ctx.federation.transaction(() => {
        revokeFederationContact(contact, receivedAtMs, ctx);
        ctx.federation.terminatePendingForRevokedContact(
          contact.id,
          contact.generation,
          inbox.deliveryId,
          receivedAtMs,
        );
      });
      if (contact.state !== "revoked") ctx.broadcastToUserUid(contact.ownerUid, "contact.changed");
      await ctx.reconcileResponsibilityWake(contact.ownerUid);
  }
}

async function commitInboundMessage(
  inbox: FederationInboxRecord,
  contact: FederationContactRecord,
  ctx: KernelContext,
): Promise<void> {
  const payload = inbox.payload;
  if (payload.kind !== "message") throw new Error("Inbox payload is not a message");
  if (payload.threadId !== contact.threadId) {
    throw new PublicFederationError(409, "Contact thread does not match this relationship");
  }
  const { social } = payload;
  if (social.reference.did !== contact.remoteDid
    || social.reference.messageId !== payload.messageId || social.threadId !== contact.threadId) {
    throw new PublicFederationError(409, "Message origin does not match this relationship");
  }
  // A reply quotes one of the two people in this conversation.
  if (social.replyTo && social.replyTo.did !== contact.remoteDid && social.replyTo.did !== await ensureShipDid(ctx)) {
    throw new PublicFederationError(409, "Reply origin is outside this relationship");
  }
  const conversation = await ensureContactConversation(contact, ctx);
  const messageId = await stableOpaqueId(
    "msg",
    [contact.id, contact.generation, inbox.deliveryId],
  );
  const resources = validateFederationResourceDescriptors(payload.resources);
  const media = resources?.map((resource) => localizeResource(contact, resource));
  const existing = await getConversationById(ctx.installationId, conversation.id).resolveOrigin(social.reference, social.threadId);
  if (existing && existing.messageId !== messageId) {
    throw new PublicFederationError(409, "Message origin has already been delivered");
  }
  const appended = await getConversationById(ctx.installationId, conversation.id).append({
    messageId,
    idempotencyKey: `federation:${contact.id}:${contact.generation}:${inbox.deliveryId}`,
    author: contactAuthor(contact),
    text: payload.text,
    social,
    ...(media?.length ? { media } : undefined),
    ...(media?.length
      ? { mediaAuthority: { kind: "federation", target: contact.id } as const }
      : undefined),
    origin: { kind: "federation", contactId: contact.id, deliveryId: inbox.deliveryId },
    createdAt: inbox.receivedAtMs,
  });
  ctx.conversations.recordContactMessage(appended.message, ctx.federation.get(contact.id)?.preferences.muted ?? true);
  if (appended.created) broadcastCommittedMessage(contact, appended.message, ctx);
  admitContactMessage(contact, inbox, appended.message, ctx);
  // Queue even on recovery: the event may have committed before its delivery was scheduled.
  await ctx.queueShipEvents(contact.ownerUid);
  await ctx.queueOwnerNotices(contact.ownerUid);
}

async function commitInboundRequest(
  inbox: FederationInboxRecord,
  contact: FederationContactRecord,
  ctx: KernelContext,
): Promise<void> {
  const payload = inbox.payload;
  if (payload.kind !== "request") throw new Error("Inbox payload is not a request");
  const wire = payload.request;
  if (wire.state !== "offered" || wire.revision !== 1) {
    throw new PublicFederationError(400, "New contact request is not an offer");
  }
  const localId = await stableOpaqueId(
    "request",
    [contact.id, contact.generation, wire.id],
  );
  const conversation = await ensureContactConversation(contact, ctx);
  const existed = ctx.federation.request(localId);
  let request: ContactRequestRecord;
  try {
    request = ctx.federation.transaction(() => {
      const created = ctx.federation.createRequest({
        id: localId,
        remoteId: wire.id,
        contactId: contact.id,
        contactGeneration: contact.generation,
        direction: "incoming",
        kind: boundedIdentifier(wire.kind, "Request kind"),
        title: boundedText(
          wire.title,
          "Request title",
          MAX_FEDERATION_REQUEST_TITLE_BYTES,
          false,
        ),
        ...(wire.details ? { details: boundedDetails(wire.details) } : undefined),
        state: "offered",
        exchange: { state: "acknowledged", source: "remote", deliveryId: inbox.deliveryId },
        createdAtMs: inbox.receivedAtMs,
        updatedAtMs: inbox.receivedAtMs,
      });
      syncFederationRequestResponsibility({
        request: created,
        contact,
        conversationId: conversation.id,
        deliveryId: inbox.deliveryId,
        remoteInput: true,
        createAllowed: false,
        now: inbox.receivedAtMs,
      }, ctx);
      return created;
    });
  } catch (error) {
    if (error instanceof FederationRequestIdentityConflictError) {
      throw new PublicFederationError(409, error.message);
    }
    throw error;
  }
  if (!existed) ctx.broadcastToUserUid(contact.ownerUid, "contact.request.changed", { contactId: contact.id });
  await appendContactSystemMessage(
    contact,
    conversation.id,
    inbox.deliveryId,
    `Request received: ${request.title}`,
    request.createdAtMs,
    ctx,
  );
  await ctx.reconcileResponsibilityWake(contact.ownerUid);
}

async function commitInboundRequestUpdate(
  inbox: FederationInboxRecord,
  contact: FederationContactRecord,
  ctx: KernelContext,
): Promise<void> {
  const payload = inbox.payload;
  if (payload.kind !== "request.update") throw new Error("Inbox payload is not a request update");
  const current = ctx.federation.requestForRemoteUpdate(
    contact.id,
    contact.generation,
    payload.requestId,
  );
  if (!current) throw new PublicFederationError(404, "Contact request not found");
  const details = payload.details ? boundedDetails(payload.details) : undefined;
  const receivedAtMs = inbox.receivedAtMs;
  const updated = ctx.federation.transaction(() => {
    const latest = ctx.federation.requestForRemoteUpdate(
      contact.id,
      contact.generation,
      payload.requestId,
    );
    if (!latest) throw new PublicFederationError(404, "Contact request not found");
    const alreadyApplied = latest.revision === payload.expectedRevision + 1
      && latest.exchange?.source === "remote"
      && latest.exchange.deliveryId === inbox.deliveryId
      && latest.state === payload.state
      && latest.updatedAtMs === receivedAtMs
      && (
        details === undefined
        || (
          latest.details !== undefined
          && canonicalJson(latest.details) === canonicalJson(details)
        )
      );
    let next = latest;
    if (!alreadyApplied) {
      if (latest.revision !== payload.expectedRevision) {
        throw new PublicFederationError(409, "Contact request revision changed");
      }
      if (!isRequestTransitionAllowed(latest, payload.state, "remote")) {
        throw new PublicFederationError(
          409,
          `This participant cannot change a contact request from ${latest.state} to ${payload.state}`,
        );
      }
      next = ctx.federation.updateRequest({
        requestId: latest.id,
        expectedRevision: payload.expectedRevision,
        state: payload.state,
        exchange: { state: "acknowledged", source: "remote", deliveryId: inbox.deliveryId },
        ...(details ? { details } : undefined),
        updatedAtMs: receivedAtMs,
      });
    }
    syncFederationRequestResponsibility({
      request: next,
      contact,
      conversationId: contact.conversationId,
      deliveryId: inbox.deliveryId,
      remoteInput: true,
      createAllowed: false,
      now: receivedAtMs,
    }, ctx);
    return next;
  });
  const conversation = await ensureContactConversation(contact, ctx);
  if (updated.revision !== current.revision) {
    ctx.broadcastToUserUid(contact.ownerUid, "contact.request.changed", { contactId: contact.id });
  }
  await appendContactSystemMessage(
    contact,
    conversation.id,
    inbox.deliveryId,
    `Request ${updated.id} is now ${updated.state}.`,
    updated.updatedAtMs,
    ctx,
  );
  await ctx.reconcileResponsibilityWake(contact.ownerUid);
}

/** `space.ship.getAttachment`: a contact's Ship reads a file one of this Ship's messages granted it. */
export async function getAttachment(call: ShipCall, ctx: KernelContext): Promise<Response> {
  const { id: resourceId } = getAttachmentParamsSchema.parse(Object.fromEntries(call.params));
  const contact = ctx.federation.getByCaller(call.caller);
  if (!contact || contact.state !== "active") throw new PublicFederationError(404, "Resource not found");
  const grant = ctx.federation.grant(resourceId);
  if (
    !grant
    || grant.contactId !== contact.id
    || grant.contactGeneration !== contact.generation
  ) {
    throw new PublicFederationError(404, "Resource not found");
  }
  const now = Date.now();
  const readId = ctx.federation.transaction(() => {
    if (ctx.auth.isAccountDisabled(contact.ownerUid)
      || !isCurrentFederationResource(contact.id, contact.generation, resourceId, ctx)) {
      throw new PublicFederationError(404, "Resource not found");
    }
    pruneFederationState(ctx, now);
    consumePublicRateLimits(ctx, [
      {
        scope: `contact:${contact.id}`,
        operation: "resource.read",
        maximum: MAX_RESOURCE_READS_PER_CONTACT_PER_MINUTE,
        windowMs: RATE_WINDOW_MS,
      },
      {
        scope: "installation",
        operation: "resource.read",
        maximum: MAX_RESOURCE_READS_PER_INSTALLATION_PER_MINUTE,
        windowMs: RATE_WINDOW_MS,
      },
    ], now, "Federation resource read rate limit reached");
    const admitted = ctx.federation.beginResourceRead(
      contact.id,
      contact.generation,
      MAX_CONCURRENT_RESOURCE_READS_PER_CONTACT,
      RESOURCE_READ_LEASE_MS,
      now,
    );
    if (!admitted) {
      throw new PublicFederationError(429, "Too many concurrent federation resource reads");
    }
    return admitted;
  });
  let response: ResponseOkFrame<"fs.transfer.send">;
  try {
    response = await openGrantedResource(grant, ctx);
  } catch (error) {
    ctx.federation.finishResourceRead(readId);
    throw error;
  }
  try {
    const result = response.data;
    if (
      !result?.ok
      || !response.body
      || result.size > MAX_FEDERATION_RESOURCE_BYTES
      || !isCurrentFederationResource(contact.id, contact.generation, resourceId, ctx)
    ) {
      throw new PublicFederationError(404, "Resource not found");
    }
    const contentType = result.contentType ?? grant.source.ref.contentType;
    return new Response(federationContactStream(
      response.body.stream,
      () => isCurrentFederationResource(contact.id, contact.generation, resourceId, ctx),
      () => ctx.federation.finishResourceRead(readId),
    ), {
      status: 200,
      headers: {
        "content-type": contentType,
        "content-length": String(result.size),
        "cache-control": "private, no-store",
        [ATTACHMENT_SIZE_HEADER]: String(result.size),
        [ATTACHMENT_REVISION_HEADER]: result.revision ?? grant.source.ref.revision,
      },
    });
  } catch (error) {
    await response.body?.stream.cancel("Federation resource is unavailable").catch(() => {});
    ctx.federation.finishResourceRead(readId);
    throw error;
  }
}

async function openGrantedResource(
  grant: FederationResourceGrant,
  ctx: KernelContext,
): Promise<ResponseOkFrame<"fs.transfer.send">> {
  if (grant.source.ref.target !== "gsv") {
    throw new PublicFederationError(409, "Granted resource is not retained locally");
  }
  const account = ctx.auth.getPasswdByUid(grant.sourceUid);
  if (!account) throw new PublicFederationError(404, "Resource owner not found");
  const process = {
    uid: account.uid,
    gid: account.gid,
    gids: ctx.auth.resolveGids(account.username, account.gid),
    username: account.username,
    home: account.home,
    cwd: account.home,
  };
  const peer = kernelPeerContext({
    installationId: ctx.installationId,
    identity: process,
    calls: ctx.caps.resolve(process.gids),
  });
  return await handleFsTransferSend({
    path: grant.source.ref.path,
    revision: grant.source.ref.revision,
  }, {
    ...ctx,
    peer,
    callerOwnerUid: grant.sourceUid,
  }, crypto.randomUUID());
}

async function commitLocalOutboxMessage(
  outbox: FederationReadyOutboxRecord,
  contact: FederationContactRecord,
  ctx: KernelContext,
): Promise<void> {
  const local = outbox.localMessage;
  if (!local || outbox.localSequence !== undefined) return;
  const conversation = await ensureContactConversation(contact, ctx);
  const archivePid = local.media?.length ? await ensurePersonalController(contact.ownerUid, ctx) : undefined;
  const process = archivePid ? ctx.procs.get(archivePid) : undefined;
  if (local.media?.length && !process) throw new Error("Contact media archive owner is unavailable");
  const appended = await getConversationById(ctx.installationId, conversation.id).append({
    messageId: local.messageId,
    idempotencyKey: `federation-local:${outbox.deliveryId}`,
    author: local.author,
    text: local.text,
    social: local.social,
    media: local.media,
    // The handler's archive owns the bytes; the pid names the sender that the
    // send-time lineage check admitted, which may be a delegated subprocess.
    ...(local.media?.length && archivePid && process
      ? {
        mediaOwner: {
          ...processMediaOwner(archivePid, process),
          pid: local.processId ?? archivePid,
        },
      }
      : undefined),
    origin: local.origin,
    processId: local.processId,
    runId: local.runId,
    createdAt: local.createdAtMs,
  });
  ctx.federation.markLocalMessageCommitted(outbox.deliveryId, appended.message.sequence);
  ctx.conversations.recordContactMessage(appended.message, ctx.federation.get(contact.id)?.preferences.muted ?? true);
  if (appended.created) broadcastCommittedMessage(contact, appended.message, ctx);
}

export async function ensureContactConversation(
  contact: FederationContactRecord,
  ctx: KernelContext,
) {
  const conversation = ctx.conversations.ensureContact(
    contact.ownerUid,
    contactDisplayName(contact),
    contact.conversationId,
  );
  await getConversationById(ctx.installationId, conversation.id).initialize({
    ownerUid: conversation.ownerUid,
    kind: "contact",
  });
  return conversation;
}

async function appendContactSystemMessage(
  contact: FederationContactRecord,
  conversationId: string,
  deliveryId: string,
  text: string,
  createdAt: number,
  ctx: KernelContext,
): Promise<void> {
  const messageId = await stableOpaqueId(
    "msg",
    [contact.id, contact.generation, deliveryId],
  );
  const appended = await getConversationById(ctx.installationId, conversationId).append({
    messageId,
    idempotencyKey: `federation:${contact.id}:${contact.generation}:${deliveryId}`,
    author: contactAuthor(contact),
    text,
    origin: { kind: "federation", contactId: contact.id, deliveryId },
    createdAt,
  });
  ctx.conversations.recordContactMessage(appended.message, ctx.federation.get(contact.id)?.preferences.muted ?? true);
  if (appended.created) broadcastCommittedMessage(contact, appended.message, ctx);
}

function createFederationResponsibility(input: {
  ownerUid: number;
  title: string;
  details: JsonObject;
  dedupeKey: string;
  deliveryId: string;
  conversationId?: string;
}, ctx: KernelContext): void {
  ctx.responsibilities.create({
    ownerUid: input.ownerUid,
    title: input.title,
    details: input.details,
    source: {
      kind: "event",
      eventType: String(input.details.eventType),
      eventId: input.deliveryId,
    },
    ...(input.conversationId
      ? { audience: { conversationIds: [input.conversationId] } }
      : undefined),
    assignee: { kind: "ship" },
    state: "open",
    priority: "normal",
    dedupeKey: input.dedupeKey,
    actor: { kind: "system", component: "federation" },
    observedByShip: false,
    now: Date.now(),
  });
}

function createDeliveryDebtResponsibility(
  outbox: FederationOutboxRecord,
  error: string,
  ctx: KernelContext,
): void {
  createFederationResponsibility({
    ownerUid: outbox.ownerUid,
    title: `Resolve contact delivery ${outbox.deliveryId}`,
    details: {
      eventType: "federation.delivery.failed",
      deliveryId: outbox.deliveryId,
      contactId: outbox.contactId,
      attemptCount: outbox.attemptCount + 1,
      error: boundedText(error, "Delivery error", 2_048, false),
    },
    dedupeKey: `federation.delivery.failed:${outbox.deliveryId}`,
    deliveryId: outbox.deliveryId,
  }, ctx);
}

function localOutboundMessage(input: {
  messageId: string;
  text: string;
  media?: ResourceBlock[];
  handlerPid?: string;
  ownerUid: number;
  contact: FederationContactRecord;
  deliveryId: string;
  /** This Ship's DID, which names where the message came from. */
  did: string;
  replyTo?: OriginMessageRef;
  ctx: KernelContext;
  now: number;
}): FederationOutboxLocalMessage {
  let author: ConversationMessageAuthor;
  let origin: ConversationMessageOrigin;
  const social = (provenance: SocialMessageProvenance): SocialMessageMetadata => ({
    threadId: input.contact.threadId,
    reference: { did: input.did, messageId: input.messageId },
    provenance,
    ...(input.replyTo ? { replyTo: input.replyTo } : undefined),
  });
  if (input.ctx.processId) {
    const process = input.ctx.procs.get(input.ctx.processId);
    if (!process || process.ownerUid !== input.ownerUid) {
      throw new Error("Contact sender process is unavailable");
    }
    const runId = input.ctx.processRunId ?? `run:${input.deliveryId}`;
    author = { kind: "process", pid: input.ctx.processId, uid: process.uid };
    origin = { kind: "process", pid: input.ctx.processId, runId };
    return {
      messageId: input.messageId,
      text: input.text,
      social: social({ kind: "process", processId: input.ctx.processId }),
      media: input.media,
      author,
      origin,
      processId: input.ctx.processId,
      runId,
      createdAtMs: input.now,
    };
  }
  author = { kind: "user", uid: input.ownerUid };
  origin = {
    kind: "client",
    clientId: input.ctx.peer?.peer.id,
    platform: input.ctx.peer?.peer.principal.kind,
  };
  return {
    messageId: input.messageId,
    text: input.text,
    social: social({ kind: "human" }),
    media: input.media,
    author,
    origin,
    processId: input.handlerPid,
    createdAtMs: input.now,
  };
}

function contactAuthor(contact: FederationContactRecord): ConversationMessageAuthor {
  return { kind: "contact", contactId: contact.id, displayName: contact.remoteName };
}

function broadcastCommittedMessage(
  contact: FederationContactRecord,
  message: ConversationMessage,
  ctx: KernelContext,
): void {
  const current = ctx.federation.get(contact.id);
  const attention = message.author.kind === "contact" && current?.state === "active" && !current.blocked && !current.preferences.muted
    ? "notify" : "quiet";
  ctx.broadcastToUserUid(contact.ownerUid, "message.committed", { message, directed: false, attention });
  ctx.broadcastToUserUid(contact.ownerUid, "conversation.changed", {
    conversationId: message.conversationId,
    latestSequence: message.sequence,
  });
}

function normalizeIdempotencyKey(value: string | undefined): string {
  const key = value?.trim() || crypto.randomUUID();
  if (key.length > 256) throw new Error("Contact idempotency key is too long");
  return key;
}

function boundedIdentifier(value: string, label: string): string {
  const identifier = value.trim();
  if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/i.test(identifier) || identifier.length > 128) {
    throw new Error(`${label} is invalid`);
  }
  return identifier;
}

function boundedText(
  value: string,
  label: string,
  maxBytes: number,
  allowEmpty: boolean,
): string {
  if (!allowEmpty && !value.trim()) throw new Error(`${label} is required`);
  if (encoder.encode(value).byteLength > maxBytes) {
    throw new Error(`${label} exceeds ${maxBytes} bytes`);
  }
  return value;
}

function boundedDetails(value: JsonObject): JsonObject {
  const canonical = canonicalJson(value);
  if (encoder.encode(canonical).byteLength > MAX_FEDERATION_REQUEST_DETAILS_BYTES) {
    throw new Error(`Request details exceed ${MAX_FEDERATION_REQUEST_DETAILS_BYTES} bytes`);
  }
  return value;
}

function decodeLocalResourcePath(pathValue: string): string {
  const prefix = "/resources/";
  if (!pathValue.startsWith(prefix)) throw new Error("Contact resource path is invalid");
  const resourceId = decodeURIComponent(pathValue.slice(prefix.length));
  if (!resourceId.startsWith("resource:")) throw new Error("Contact resource path is invalid");
  return resourceId;
}

function parseResourceSize(value: string | null): number {
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error("Remote resource size is invalid");
  }
  return size;
}

function jsonValue<Value>(value: Value): JsonValue {
  return jsonValueSchema.parse(value);
}
