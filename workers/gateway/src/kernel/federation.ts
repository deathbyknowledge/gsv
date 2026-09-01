import type {
  ContactAliasSetArgs,
  ContactAliasSetResult,
  ContactIdentityResult,
  ContactInviteAcceptArgs,
  ContactInviteAcceptResult,
  ContactInviteCancelArgs,
  ContactInviteCancelResult,
  ContactInviteCreateArgs,
  ContactInviteCreateResult,
  ContactInviteListArgs,
  ContactInviteListResult,
  ContactInviteSummary,
  ContactDeliveryGetArgs,
  ContactDeliveryGetResult,
  ContactListArgs,
  ContactListResult,
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
  ContactSummary,
  ConversationMessage,
  ConversationMessageAuthor,
  ConversationMessageOrigin,
  FederationDeliveryEnvelope,
  FederationDeliveryReceipt,
  FederationRequestDelivery,
  FederationShipDocument,
  FederationSubject,
  FsCopyEndpoint,
  FsReadArgs,
  FsReadResult,
  FsTransferSendArgs,
  JsonObject,
  JsonValue,
  ResourceBlock,
} from "@humansandmachines/gsv/protocol";
import {
  bodyToBytes,
  contactDisplayName,
  federationDeliveryEnvelopeSchema,
  federationDeliveryReceiptSchema,
  federationShipDocumentSchema,
  federationSubjectSchema,
  jsonObjectSchema,
  jsonValueSchema,
  MAX_FEDERATION_MESSAGE_BYTES,
  MAX_FEDERATION_REQUEST_DETAILS_BYTES,
  MAX_FEDERATION_REQUEST_TITLE_BYTES,
  MAX_FEDERATION_RESOURCE_BYTES,
} from "@humansandmachines/gsv/protocol";
import * as z from "zod";
import type { FrameBody, ResponseOkFrame } from "../protocol/frames";
import { getConversationById } from "../shared/utils";
import { stableOpaqueId } from "../shared/stable-id";
import {
  handleFsReadTransfer,
  handleFsTransferSend,
  type FsOpenedSource,
} from "../drivers/native/fs";
import { isLocked } from "../auth/shadow";
import type { ConnectionIdentity } from "./identity";
import type { KernelContext } from "./context";
import { resolveCallerOwnerUid } from "./context";
import { ensurePersonalController } from "./personal-controller";
import {
  processMediaOwner,
  retainConversationResources,
} from "./conversation-handlers";
import {
  FederationRequestIdentityConflictError,
  type FederationContactRecord,
  type FederationInboxRecord,
  type FederationInviteRecord,
  type FederationOutboxLocalMessage,
  type FederationOutboxRecord,
  type FederationPreparingOutboxRecord,
  type FederationReadyOutboxRecord,
  type FederationResourceGrant,
  isReadyFederationOutbox,
} from "./federation-store";
import {
  base64UrlDecode,
  base64UrlEncode,
  canonicalJson,
  deriveContactSecret,
  normalizeFederationOrigin,
  randomBase64Url,
  sha256Base64Url,
  signContactEnvelope,
  verifyContactEnvelope,
  verifyShipDocument,
  verifySignedValue,
} from "./federation-crypto";
import {
  activateFederationContact,
  assertPairingAttemptCanContinue,
  assertPairingAttemptIdentity,
  requireCommittedPairingContact,
  revokeFederationContact,
} from "./federation/pairing";
import { FederationHttpError, PublicFederationError } from "./federation/errors";
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
  assertContactCapacity,
  assertInboundCapacity,
  assertOutboundCapacity,
  assertRequestCapacity,
  consumeInboundDeliveryRate,
  consumeLocalRateLimits,
  consumeOutboundDeliveryRate,
  consumePublicRateLimits,
  pruneFederationState,
  RECEIPT_RETENTION_MS,
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

const SHIP_DOCUMENT_PATH = "/.well-known/gsv/federation/v1/ship";
const INVITE_ACCEPT_PATH = "/_gsv/federation/v1/invites/accept";
const DELIVERY_PATH = "/_gsv/federation/v1/deliver";
const RESOURCE_PATH_PREFIX = "/_gsv/federation/v1/resources/";
const INVITE_PREFIX = "gsv-contact-v1:";
const DEFAULT_INVITE_LIFETIME_MS = 60 * 60_000;
const MAX_INVITE_LIFETIME_MS = 7 * 24 * 60 * 60_000;
const MAX_PUBLIC_JSON_BYTES = 128 * 1024;
const MAX_CONTACT_DISPLAY_NAME_BYTES = 256;
const MAX_OUTSTANDING_INVITES_PER_OWNER = 20;
const MAX_INVITES_CREATED_PER_HOUR = 20;
const MAX_RESOURCE_READS_PER_CONTACT_PER_MINUTE = 240;
const MAX_RESOURCE_READS_PER_INSTALLATION_PER_MINUTE = 1_000;
const MAX_CONCURRENT_RESOURCE_READS_PER_CONTACT = 8;
const RESOURCE_READ_LEASE_MS = 15 * 60_000;
const RATE_WINDOW_MS = 60_000;
export const MAX_FEDERATION_RECOVERABLE_OUTBOX = 1_500;
export const MAX_FEDERATION_RECOVERABLE_INBOX = 250;
export const FEDERATION_INBOX_RECOVERY_RETRY_MS = 30_000;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const MAX_DELIVERY_ATTEMPTS = 12;
const MAX_DELIVERY_AGE_MS = 7 * 24 * 60 * 60_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

const inviteCodeSchema = z.strictObject({
  version: z.literal(1),
  origin: z.string().min(1).max(2_048),
  shipId: z.string().min(1).max(128),
  subject: federationSubjectSchema,
  token: z.string().min(1).max(128),
  expiresAtMs: z.number().int().nonnegative(),
});

const inviteAcceptSchema = z.strictObject({
  version: z.literal(1),
  token: z.string().min(1).max(128),
  document: federationShipDocumentSchema,
  subject: federationSubjectSchema,
});

const inviteAcceptResponseSchema = z.strictObject({
  version: z.literal(1),
  recipientShipId: z.string().min(1).max(128),
  recipientSubjectId: z.string().min(1).max(128),
  generation: z.string().min(1).max(128),
  threadId: z.string().min(1).max(128),
  document: federationShipDocumentSchema,
  subject: federationSubjectSchema,
  signature: z.string().min(1).max(512),
});

const resourceRequestHeadersSchema = z.strictObject({
  senderShipId: z.string().min(1).max(128),
  senderSubjectId: z.string().min(1).max(128),
  recipientSubjectId: z.string().min(1).max(128),
  generation: z.string().min(1).max(128),
  timestampMs: z.coerce.number().int().nonnegative(),
  nonce: z.string().min(1).max(128),
  signature: z.string().min(1).max(512),
});

type InviteAcceptResponse = z.infer<typeof inviteAcceptResponseSchema>;
type InviteAcceptResponseUnsigned = Omit<InviteAcceptResponse, "signature">;
type PublicFederationFailure = { status: number; message: string; retryAfterMs?: number };

export function isFederationPublicPath(pathname: string): boolean {
  return pathname === SHIP_DOCUMENT_PATH
    || pathname === INVITE_ACCEPT_PATH
    || pathname === DELIVERY_PATH
    || pathname.startsWith(RESOURCE_PATH_PREFIX);
}

export async function handleContactIdentity(
  ctx: KernelContext,
): Promise<ContactIdentityResult> {
  const ownerUid = requireContactCaller(ctx, false);
  return {
    document: await localShipDocument(ctx),
    subject: ensureLocalSubject(ownerUid, ctx),
  };
}

export async function handleContactInviteCreate(
  args: ContactInviteCreateArgs,
  ctx: KernelContext,
): Promise<ContactInviteCreateResult> {
  const ownerUid = requireContactCaller(ctx, true);
  const now = Date.now();
  pruneFederationState(ctx, now);
  const document = await localShipDocument(ctx);
  const subject = ensureLocalSubject(ownerUid, ctx);
  const expiresInSeconds = args.expiresInSeconds ?? DEFAULT_INVITE_LIFETIME_MS / 1_000;
  if (!Number.isSafeInteger(expiresInSeconds) || expiresInSeconds <= 0) {
    throw new Error("Invite lifetime must be a positive whole number of seconds");
  }
  const lifetimeMs = expiresInSeconds * 1_000;
  if (lifetimeMs > MAX_INVITE_LIFETIME_MS) {
    throw new Error("Invite lifetime exceeds seven days");
  }
  const token = randomBase64Url(32);
  const tokenHash = await sha256Base64Url(token);
  const expiresAtMs = now + lifetimeMs;
  const invite = ctx.federation.transaction(() => {
    if (ctx.federation.outstandingInviteCount(ownerUid, now) >= MAX_OUTSTANDING_INVITES_PER_OWNER) {
      throw new Error("Outstanding contact invite limit reached");
    }
    consumeLocalRateLimits(ctx, [{
      scope: `owner:${ownerUid}`,
      operation: "invite.create",
      maximum: MAX_INVITES_CREATED_PER_HOUR,
      windowMs: 60 * 60_000,
    }], now, "Contact invite rate limit reached");
    return ctx.federation.createInvite({
      ownerUid,
      tokenHash,
      issuingShipId: document.shipId,
      issuingOrigin: document.origin,
      expiresAtMs,
      now,
    });
  });
  const code = encodeInviteCode({
    version: 1,
    origin: document.origin,
    shipId: document.shipId,
    subject,
    token,
    expiresAtMs,
  });
  return { inviteId: invite.inviteId, code, expiresAtMs };
}

export function handleContactInviteList(
  args: ContactInviteListArgs,
  ctx: KernelContext,
): ContactInviteListResult {
  const ownerUid = requireContactCaller(ctx, false);
  const now = Date.now();
  pruneFederationState(ctx, now);
  return {
    invites: ctx.federation
      .listInvites(ownerUid, args.includeTerminal ?? false, now)
      .map((invite) => contactInviteSummary(invite, now)),
  };
}

export function handleContactInviteCancel(
  args: ContactInviteCancelArgs,
  ctx: KernelContext,
): ContactInviteCancelResult {
  const ownerUid = requireContactCaller(ctx, true);
  const now = Date.now();
  const inviteId = args.inviteId.trim();
  if (!inviteId.startsWith("invite:")) throw new Error("Contact invite id is invalid");
  const invite = ctx.federation.cancelInvite(inviteId, ownerUid, now);
  return { invite: contactInviteSummary(invite, now) };
}

export async function handleContactInviteAccept(
  args: ContactInviteAcceptArgs,
  ctx: KernelContext,
): Promise<ContactInviteAcceptResult> {
  ctx.requestSignal?.throwIfAborted();
  const ownerUid = requireContactCaller(ctx, true);
  const now = Date.now();
  pruneFederationState(ctx, now);
  const invite = decodeInviteCode(args.code);
  const tokenHash = await sha256Base64Url(invite.token);
  const remoteOrigin = normalizeFederationOrigin(invite.origin);
  const recordedAttempt = ctx.federation.pairingAttempt(tokenHash);
  if (recordedAttempt) {
    assertPairingAttemptIdentity(recordedAttempt, {
      ownerUid,
      expiresAtMs: invite.expiresAtMs,
      remoteShipId: invite.shipId,
      remoteSubjectId: invite.subject.id,
      remoteOrigin,
    });
    assertPairingAttemptCanContinue(recordedAttempt);
    if (recordedAttempt.state === "committed") {
      const committed = requireCommittedPairingContact(recordedAttempt, ctx);
      await ensureContactConversation(committed, ctx);
      return { contact: contactSummary(committed) };
    }
  }
  if (!recordedAttempt && invite.expiresAtMs <= now) {
    throw new Error("Contact invite has expired");
  }
  const remoteDocument = federationShipDocumentSchema.parse(await fetchJson(
    `${remoteOrigin}${SHIP_DOCUMENT_PATH}`,
    {
      method: "GET",
      headers: { accept: "application/json" },
      signal: ctx.requestSignal,
    },
  ));
  await verifyShipDocument(remoteDocument);
  if (remoteDocument.shipId !== invite.shipId || remoteDocument.origin !== remoteOrigin) {
    throw new Error("Contact invite does not match the remote Ship");
  }
  assertContactCapacity(
    ownerUid,
    remoteDocument.shipId,
    invite.subject.id,
    ctx,
  );

  const localDocument = await localShipDocument(ctx);
  const localSubject = ensureLocalSubject(ownerUid, ctx);
  const attempt = ctx.federation.transaction(() => ctx.federation.beginPairingAttempt({
    tokenHash,
    ownerUid,
    expiresAtMs: invite.expiresAtMs,
    remoteShipId: remoteDocument.shipId,
    remoteSubjectId: invite.subject.id,
    remoteOrigin: remoteDocument.origin,
    remotePublicKey: remoteDocument.publicKey,
    now: Date.now(),
  }));
  assertPairingAttemptCanContinue(attempt);
  if (attempt.state === "committed") {
    const committed = requireCommittedPairingContact(attempt, ctx);
    await ensureContactConversation(committed, ctx);
    return { contact: contactSummary(committed) };
  }
  ctx.requestSignal?.throwIfAborted();
  let accepted: InviteAcceptResponse;
  try {
    accepted = inviteAcceptResponseSchema.parse(await fetchJson(
      `${remoteOrigin}${INVITE_ACCEPT_PATH}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          version: 1,
          token: invite.token,
          document: localDocument,
          subject: localSubject,
        }),
        signal: ctx.requestSignal,
      },
    ));
  } catch (error) {
    if (error instanceof FederationHttpError && isTerminalFederationError(error)) {
      ctx.federation.terminatePairingAttempt(
        tokenHash,
        `remote-rejected:${error.status}`,
      );
    }
    throw error;
  }
  await verifyShipDocument(accepted.document);
  if (
    accepted.document.shipId !== remoteDocument.shipId
    || accepted.document.origin !== remoteDocument.origin
    || accepted.subject.id !== invite.subject.id
    || accepted.recipientShipId !== localDocument.shipId
    || accepted.recipientSubjectId !== localSubject.id
  ) {
    throw new Error("Contact acceptance identity does not match the invite");
  }
  const unsigned = inviteAcceptResponseUnsigned(accepted);
  if (!await verifySignedValue(accepted.document.publicKey, jsonValue(unsigned), accepted.signature)) {
    throw new Error("Contact acceptance signature is invalid");
  }
  const secret = await deriveContactSecret(
    invite.token,
    localDocument.shipId,
    remoteDocument.shipId,
  );
  const activate = () => ctx.federation.transaction(() => {
    const currentAttempt = ctx.federation.pairingAttempt(tokenHash);
    if (!currentAttempt) throw new Error("Contact pairing attempt not found");
    assertPairingAttemptIdentity(currentAttempt, {
      ownerUid,
      expiresAtMs: invite.expiresAtMs,
      remoteShipId: accepted.document.shipId,
      remoteSubjectId: accepted.subject.id,
      remoteOrigin: accepted.document.origin,
      remotePublicKey: accepted.document.publicKey,
    });
    assertPairingAttemptCanContinue(currentAttempt);
    if (currentAttempt.state === "committed") {
      if (
        currentAttempt.generation !== accepted.generation
        || currentAttempt.threadId !== accepted.threadId
      ) {
        throw new Error("Contact acceptance changed after it was committed");
      }
      return requireCommittedPairingContact(currentAttempt, ctx);
    }
    assertContactCapacity(
      ownerUid,
      accepted.document.shipId,
      accepted.subject.id,
      ctx,
    );
    const activated = activateFederationContact({
      ownerUid,
      inviteDirection: "incoming",
      generation: accepted.generation,
      remoteShipId: accepted.document.shipId,
      remoteSubject: accepted.subject,
      remoteOrigin: accepted.document.origin,
      remotePublicKey: accepted.document.publicKey,
      sharedSecret: secret,
      threadId: accepted.threadId,
      pairingAttemptTokenHash: tokenHash,
      now: Date.now(),
    }, ctx);
    ctx.federation.commitPairingAttempt({
      tokenHash,
      contactId: activated.id,
      generation: accepted.generation,
      threadId: accepted.threadId,
    });
    return activated;
  });
  const contact = await ctx.coordinateFederationContact(
    `pairing:${ownerUid}:${accepted.document.shipId}:${accepted.subject.id}`,
    activate,
  );
  await ensureContactConversation(contact, ctx);
  await ctx.reconcileResponsibilityWake(ownerUid);
  return {
    contact: contactSummary(requireOwnedActiveContactGeneration(contact, ownerUid, ctx)),
  };
}

export function handleContactList(
  args: ContactListArgs,
  ctx: KernelContext,
): ContactListResult {
  const ownerUid = requireContactCaller(ctx, false);
  return {
    contacts: ctx.federation.list(ownerUid, args.includeRevoked ?? false).map(contactSummary),
  };
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
        payload: {
          kind: "contact.revoked",
          generation: current.generation,
        },
        now: revokedAtMs,
      });
      revokeFederationContact(current, revokedAtMs, ctx);
    });
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
  const fingerprint = await federationInputFingerprint(jsonValue({
    operation: "contact.send",
    contactId: contact.id,
    text,
    media: requestedMedia ?? [],
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
  const processId = await ensurePersonalController(ownerUid, ctx);
  const process = ctx.procs.get(processId);
  if (!process) throw new Error("Personal intelligence is unavailable");
  ctx.requestSignal?.throwIfAborted();
  ensureLocalSubject(ownerUid, ctx);
  const deliveryId = `delivery:${crypto.randomUUID()}`;
  const messageId = await stableOpaqueId(
    "msg",
    [contact.id, contact.generation, idempotencyKey],
  );
  const localMessage = localOutboundMessage({
    messageId,
    text,
    handlerPid: processId,
    ownerUid,
    contact,
    deliveryId,
    ctx,
    now,
  });
  ctx.requestSignal?.throwIfAborted();
  const admitted = ctx.federation.transaction(() => {
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
  });
  await ctx.scheduleFederationDelivery(admitted.deliveryId, now, true);
  const record = admitted.state === "preparing"
    ? await advanceFederationMessagePreparationOrRecordFailure(admitted, ctx)
    : admitted;
  ctx.requestSignal?.throwIfAborted();
  return contactSendResult(record, contact);
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
    createdAtMs: now,
    updatedAtMs: now,
  };
  const deliveryId = `delivery:${crypto.randomUUID()}`;
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
  assertRequestTransition(current.state, args.state);
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
      details,
      updatedAtMs: now,
    });
    syncFederationRequestResponsibility({
      request: next,
      contact,
      conversationId: contact.conversationId,
      deliveryId,
      remoteInput: false,
      createAllowed: current.direction === "outgoing"
        || ctx.responsibilitySources.isEnabled(ownerUid, "federation.received"),
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
    const document = await localShipDocument(ctx);
    if (!currentFederationDeliveryContact(record, ctx)) return;
    const subject = ensureLocalSubject(record.ownerUid, ctx);
    const unsigned = {
      version: 1,
      deliveryId: record.deliveryId,
      senderShipId: document.shipId,
      senderSubjectId: subject.id,
      recipientSubjectId: contact.remoteSubject.id,
      generation: record.contactGeneration,
      timestampMs: Date.now(),
      nonce: randomBase64Url(18),
      payload: record.payload,
    } satisfies Omit<FederationDeliveryEnvelope, "signature">;
    const envelope: FederationDeliveryEnvelope = {
      ...unsigned,
      signature: await signContactEnvelope(contact.sharedSecret, jsonValue(unsigned)),
    };
    if (!currentFederationDeliveryContact(record, ctx)) return;
    const receipt = federationDeliveryReceiptSchema.parse(await fetchJson(
      `${contact.remoteOrigin}${DELIVERY_PATH}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(envelope),
      },
    ));
    if (receipt.deliveryId !== record.deliveryId) {
      throw new Error("Remote Ship returned a receipt for another delivery");
    }
    const { signature, ...receiptUnsigned } = receipt;
    if (!await verifyContactEnvelope(
      contact.sharedSecret,
      jsonValue(receiptUnsigned),
      signature,
    )) {
      throw new Error("Remote delivery receipt signature is invalid");
    }
    const committedAtMs = Date.now();
    const committed = ctx.federation.transaction(() => {
      if (!ctx.federation.markDeliverySucceeded(
        deliveryId,
        record.contactGeneration,
        committedAtMs,
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
      return true;
    });
    if (!committed) return;
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
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
  const processId = await ensurePersonalController(record.ownerUid, ctx);
  const retained = await retainConversationResources(
    record.preparation.resources,
    processId,
    ctx,
    record.deliveryId,
  ) ?? [];
  if (retained.length !== record.preparation.resources.length) {
    throw new Error("Personal intelligence retained an incomplete resource batch");
  }
  const now = Date.now();
  return ctx.federation.transaction(() => {
    const current = ctx.federation.outbox(record.deliveryId);
    if (!current) throw new Error("Contact message preparation disappeared");
    if (current.state !== "preparing") return current;
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
      ...(current.preparation.localMessage.author.kind === "user"
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
  ) {
    return;
  }
  const contact = ctx.federation.get(record.contactId);
  const contactActive = contact?.state === "active"
    && contact.generation === record.contactGeneration;
  const attempt = latest.attemptCount + 1;
  const terminal = !contactActive
    || attempt >= MAX_DELIVERY_ATTEMPTS
    || Date.now() - record.createdAtMs >= MAX_DELIVERY_AGE_MS
    || isTerminalFederationError(error);
  const retryAt = terminal ? null : Date.now() + deliveryRetryDelayMs(attempt);
  const message = error.message;
  if (!ctx.federation.markOutboxFailed(
    record.deliveryId,
    record.contactGeneration,
    record.state,
    message,
    retryAt,
    terminal,
  )) {
    return;
  }
  if (terminal) {
    if (contactActive) {
      createDeliveryDebtResponsibility(record, message, ctx);
      await ctx.reconcileResponsibilityWake(record.ownerUid);
    }
    return;
  }
  await ctx.scheduleFederationDelivery(record.deliveryId, retryAt!, false);
}

export async function handleFederationHttpRequest(
  request: Request,
  ctx: KernelContext,
): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (url.pathname === SHIP_DOCUMENT_PATH && request.method === "GET") {
      return jsonResponse(await localShipDocument(ctx));
    }
    if (url.pathname === INVITE_ACCEPT_PATH && request.method === "POST") {
      return jsonResponse(await acceptRemoteInvite(
        inviteAcceptSchema.parse(await readBoundedJson(request)),
        ctx,
      ));
    }
    if (url.pathname === DELIVERY_PATH && request.method === "POST") {
      return jsonResponse(await receiveRemoteDelivery(
        federationDeliveryEnvelopeSchema.parse(await readBoundedJson(request)),
        ctx,
      ));
    }
    if (url.pathname.startsWith(RESOURCE_PATH_PREFIX) && request.method === "GET") {
      return await serveRemoteResource(request, ctx);
    }
    return new Response("Not Found", { status: 404 });
  } catch (error) {
    const failure = publicFederationFailure(error);
    return jsonResponse(
      { error: failure.message },
      failure.status,
      failure.retryAfterMs === undefined
        ? undefined
        : { "retry-after": String(Math.max(1, Math.ceil(failure.retryAfterMs / 1_000))) },
    );
  }
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
  const document = await localShipDocument(ctx);
  requireOwnedActiveContactGeneration(contact, ownerUid, ctx);
  const subject = ensureLocalSubject(ownerUid, ctx);
  const path = `${RESOURCE_PATH_PREFIX}${encodeURIComponent(resourceId)}`;
  const requestFields = {
    version: 1,
    method: "GET",
    path,
    senderShipId: document.shipId,
    senderSubjectId: subject.id,
    recipientSubjectId: contact.remoteSubject.id,
    generation: contact.generation,
    timestampMs: Date.now(),
    nonce: randomBase64Url(18),
  };
  const signature = await signContactEnvelope(
    contact.sharedSecret,
    jsonValue(requestFields),
  );
  requireOwnedActiveContactGeneration(contact, ownerUid, ctx);
  const response = await fetch(`${contact.remoteOrigin}${path}`, {
    method: "GET",
    headers: resourceRequestHeaders(requestFields, signature),
    redirect: "manual",
    signal: ctx.requestSignal,
  });
  if (!isCurrentFederationContact(contact.id, contact.generation, ctx)) {
    await response.body?.cancel("Contact generation changed during resource read").catch(() => {});
    throw new Error("Contact generation changed during resource read");
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Remote resource request failed (${response.status})`);
  }
  const size = parseResourceSize(response.headers.get("x-gsv-resource-size"));
  if (size > MAX_FEDERATION_RESOURCE_BYTES) {
    await response.body.cancel("Remote resource exceeds the federation limit").catch(() => {});
    throw new Error(`Remote resource exceeds ${MAX_FEDERATION_RESOURCE_BYTES} bytes`);
  }
  const revision = response.headers.get("x-gsv-resource-revision") ?? "";
  const contentType = response.headers.get("content-type") ?? "application/octet-stream";
  const responseSignature = response.headers.get("x-gsv-resource-signature") ?? "";
  const responseFields = {
    version: 1,
    resourceId,
    requestNonce: requestFields.nonce,
    size,
    revision,
    contentType,
  };
  if (!await verifyContactEnvelope(
    contact.sharedSecret,
    jsonValue(responseFields),
    responseSignature,
  )) {
    await response.body.cancel("Remote resource signature is invalid").catch(() => {});
    throw new Error("Remote resource signature is invalid");
  }
  if (!isCurrentFederationContact(contact.id, contact.generation, ctx)) {
    await response.body.cancel("Contact generation changed during resource read").catch(() => {});
    throw new Error("Contact generation changed during resource read");
  }
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

async function acceptRemoteInvite(
  input: z.infer<typeof inviteAcceptSchema>,
  ctx: KernelContext,
): Promise<InviteAcceptResponse> {
  const now = Date.now();
  const tokenHash = await sha256Base64Url(input.token);
  const invite = ctx.federation.inviteByTokenHash(tokenHash);
  if (!invite) throw new PublicFederationError(404, "Contact invite not found");
  if (invite.state === "cancelled") {
    throw new PublicFederationError(410, "Contact invite was cancelled");
  }
  if (invite.state === "issued" && invite.expiresAtMs <= now) {
    throw new PublicFederationError(410, "Contact invite has expired");
  }
  if (invite.state === "accepted" && invite.acceptedAtMs <= now - RECEIPT_RETENTION_MS) {
    throw new PublicFederationError(410, "Contact invite replay window has expired");
  }
  pruneFederationState(ctx, now);
  await verifyShipDocument(input.document);
  const localDocument = await localShipDocument(ctx);
  if (
    localDocument.shipId !== invite.issuingShipId
    || localDocument.origin !== invite.issuingOrigin
  ) {
    throw new PublicFederationError(410, "Contact invite issuer identity changed");
  }
  if (input.document.origin === localDocument.origin) {
    throw new PublicFederationError(400, "A Ship cannot pair with itself");
  }
  const localSubject = ctx.federation.subject(invite.ownerUid);
  if (!localSubject) throw new PublicFederationError(409, "Contact invite owner is unavailable");

  const sharedSecret = await deriveContactSecret(
    input.token,
    localDocument.shipId,
    input.document.shipId,
  );
  const generation = `generation:${randomBase64Url(24)}`;
  const threadId = `thread:${await sha256Base64Url(`federation-thread\n${input.token}`)}`;
  const remoteSubject = normalizeSubject(input.subject);
  const proposedUnsigned: InviteAcceptResponseUnsigned = {
    version: 1,
    recipientShipId: input.document.shipId,
    recipientSubjectId: remoteSubject.id,
    generation,
    threadId,
    document: localDocument,
    subject: localSubject,
  };
  const proposedResponse: InviteAcceptResponse = {
    ...proposedUnsigned,
    signature: await ctx.federationIdentity.sign(jsonValue(proposedUnsigned)),
  };
  const claim = () => ctx.federation.transaction(() => {
    const currentInvite = ctx.federation.inviteByTokenHash(tokenHash);
    if (!currentInvite) throw new PublicFederationError(404, "Contact invite not found");
    const claimNow = Date.now();
    if (currentInvite.state === "accepted") {
      if (currentInvite.acceptedAtMs <= claimNow - RECEIPT_RETENTION_MS) {
        throw new PublicFederationError(410, "Contact invite replay window has expired");
      }
      if (
        currentInvite.acceptedRemoteShipId !== input.document.shipId
        || currentInvite.acceptedRemoteSubjectId !== remoteSubject.id
      ) {
        throw new PublicFederationError(409, "Contact invite was already accepted");
      }
      const acceptedContact = ctx.federation.get(currentInvite.acceptedContactId);
      if (!acceptedContact) {
        throw new PublicFederationError(500, "Accepted contact is unavailable");
      }
      if (acceptedContact.state !== "active") {
        throw new PublicFederationError(410, "Accepted contact is no longer active");
      }
      if (
        acceptedContact.generation !== currentInvite.acceptedGeneration
        || acceptedContact.threadId !== currentInvite.acceptedThreadId
        || acceptedContact.remoteOrigin !== input.document.origin
        || acceptedContact.sharedSecret !== sharedSecret
        || canonicalJson(jsonValue(acceptedContact.remotePublicKey))
          !== canonicalJson(jsonValue(input.document.publicKey))
      ) {
        throw new PublicFederationError(410, "Accepted contact was superseded");
      }
      const response = inviteAcceptResponseSchema.parse(currentInvite.acceptedResponse);
      if (
        response.generation !== currentInvite.acceptedGeneration
        || response.threadId !== currentInvite.acceptedThreadId
        || response.recipientShipId !== input.document.shipId
        || response.recipientSubjectId !== remoteSubject.id
      ) {
        throw new PublicFederationError(500, "Accepted invite response is inconsistent");
      }
      return {
        contact: acceptedContact,
        response,
      };
    }
    if (currentInvite.state === "cancelled") {
      throw new PublicFederationError(410, "Contact invite was cancelled");
    }
    if (currentInvite.expiresAtMs <= claimNow) {
      throw new PublicFederationError(410, "Contact invite has expired");
    }
    assertContactCapacity(
      currentInvite.ownerUid,
      input.document.shipId,
      remoteSubject.id,
      ctx,
      true,
    );
    const activated = activateFederationContact({
      ownerUid: currentInvite.ownerUid,
      inviteDirection: "outgoing",
      generation,
      remoteShipId: input.document.shipId,
      remoteSubject,
      remoteOrigin: input.document.origin,
      remotePublicKey: input.document.publicKey,
      sharedSecret,
      threadId,
      now: claimNow,
    }, ctx);
    if (!ctx.federation.acceptInvite({
      tokenHash,
      remoteShipId: input.document.shipId,
      remoteSubjectId: remoteSubject.id,
      contactId: activated.id,
      generation: activated.generation,
      threadId: activated.threadId,
      response: jsonObject(proposedResponse),
      now: claimNow,
    })) {
      throw new PublicFederationError(409, "Contact invite was already consumed");
    }
    return {
      contact: activated,
      response: proposedResponse,
    };
  });
  const acceptance = await ctx.coordinateFederationContact(
    `pairing:${invite.ownerUid}:${input.document.shipId}:${remoteSubject.id}`,
    claim,
  );
  await ensureContactConversation(acceptance.contact, ctx);
  await ctx.reconcileResponsibilityWake(acceptance.contact.ownerUid);
  if (!isCurrentFederationContact(
    acceptance.contact.id,
    acceptance.contact.generation,
    ctx,
  )) {
    throw new PublicFederationError(409, "Contact pairing changed during acceptance");
  }
  return acceptance.response;
}

async function receiveRemoteDelivery(
  envelope: FederationDeliveryEnvelope,
  ctx: KernelContext,
): Promise<FederationDeliveryReceipt> {
  assertCurrentTimestamp(envelope.timestampMs);
  const contact = ctx.federation.getForInbound(
    envelope.senderShipId,
    envelope.senderSubjectId,
    envelope.recipientSubjectId,
  );
  if (
    !contact
    || contact.generation !== envelope.generation
  ) {
    throw new PublicFederationError(404, "Contact not found");
  }
  const { signature, ...unsigned } = envelope;
  if (!await verifyContactEnvelope(contact.sharedSecret, jsonValue(unsigned), signature)) {
    throw new PublicFederationError(401, "Federation signature is invalid");
  }
  if (contact.state !== "active" && envelope.payload.kind !== "contact.revoked") {
    throw new PublicFederationError(404, "Contact not found");
  }
  const payloadHash = await sha256Base64Url(canonicalJson(jsonValue(envelope.payload)));
  return await ctx.coordinateFederationInbound(
    `${contact.id}:${envelope.generation}:${envelope.deliveryId}`,
    async () => await ctx.coordinateFederationContact(contact.id, async () => {
      const currentContact = ctx.federation.get(contact.id);
      if (
        !currentContact
        || currentContact.generation !== envelope.generation
        || (currentContact.state !== "active" && envelope.payload.kind !== "contact.revoked")
      ) {
        throw new PublicFederationError(404, "Contact not found");
      }
      const now = Date.now();
      pruneFederationState(ctx, now);
      const existing = ctx.federation.inbox(
        currentContact.id,
        envelope.generation,
        envelope.deliveryId,
      );
      if (
        currentContact.state !== "active"
        && (envelope.payload.kind !== "contact.revoked" || !existing)
      ) {
        throw new PublicFederationError(404, "Contact not found");
      }
      if (
        envelope.payload.kind === "contact.revoked"
        && envelope.payload.generation !== currentContact.generation
      ) {
        throw new PublicFederationError(409, "Contact revocation generation changed");
      }
      if (existing && existing.payloadHash !== payloadHash) {
        throw new PublicFederationError(409, "Federation delivery id was reused");
      }
      const received = existing ?? ctx.federation.transaction(() => {
        if (envelope.payload.kind !== "contact.revoked") {
          assertInboundCapacity(currentContact, envelope.payload, ctx, now);
          consumeInboundDeliveryRate(currentContact, ctx, now);
        }
        return ctx.federation.receive({
          contactId: currentContact.id,
          contactGeneration: envelope.generation,
          deliveryId: envelope.deliveryId,
          payloadHash,
          payload: envelope.payload,
          now,
        }).record;
      });
      if (received.state === "committed" && received.response) {
        return federationDeliveryReceiptSchema.parse(received.response);
      }
      if (received.state === "rejected") {
        throw new PublicFederationError(409, "Federation delivery was rejected");
      }
      try {
        return await projectInboundDelivery(received, currentContact, ctx);
      } catch (error) {
        if (
          ctx.federation.inbox(
            currentContact.id,
            envelope.generation,
            envelope.deliveryId,
          )?.state === "received"
        ) {
          try {
            await ctx.scheduleFederationInbox(
              currentContact.id,
              envelope.generation,
              envelope.deliveryId,
              Date.now() + FEDERATION_INBOX_RECOVERY_RETRY_MS,
              true,
            );
          } catch (scheduleError) {
            throw new AggregateError(
              [error, scheduleError],
              `Federation inbox ${envelope.deliveryId} failed and could not be requeued`,
            );
          }
        }
        throw error;
      }
    }),
  );
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
      if (inbox.state === "committed" && inbox.response) {
        return federationDeliveryReceiptSchema.parse(inbox.response);
      }
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
      if (
        inbox.payload.kind === "contact.revoked"
        && inbox.payload.generation !== contact.generation
      ) {
        ctx.federation.rejectInbox(
          contactId,
          contactGeneration,
          deliveryId,
          "Contact generation changed",
        );
        throw new PublicFederationError(409, "Contact revocation generation changed");
      }
      return await projectInboundDelivery(inbox, contact, ctx);
    }),
  );
}

async function projectInboundDelivery(
  inbox: FederationInboxRecord,
  contact: FederationContactRecord,
  ctx: KernelContext,
): Promise<FederationDeliveryReceipt> {
  try {
    await commitInboundDelivery(inbox, contact, ctx);
    const committedAtMs = Date.now();
    const receiptUnsigned = {
      version: 1,
      deliveryId: inbox.deliveryId,
    } as const;
    const receipt: FederationDeliveryReceipt = {
      ...receiptUnsigned,
      signature: await signContactEnvelope(
        contact.sharedSecret,
        jsonValue(receiptUnsigned),
      ),
    };
    if (!ctx.federation.commitInbox(
      contact.id,
      inbox.contactGeneration,
      inbox.deliveryId,
      jsonObject(receipt),
      committedAtMs,
    )) {
      throw new PublicFederationError(409, "Federation delivery is no longer admissible");
    }
    ctx.federation.markContactReceived(
      contact.id,
      inbox.contactGeneration,
      committedAtMs,
    );
    return receipt;
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
      if (inbox.payload.generation !== contact.generation) {
        throw new PublicFederationError(409, "Contact revocation generation changed");
      }
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
      createFederationResponsibility({
        ownerUid: contact.ownerUid,
        title: `Review contact change ${contact.id}`,
        details: {
          eventType: "federation.contact.revoked",
          contactId: contact.id,
          deliveryId: inbox.deliveryId,
          remoteDisplayName: contactDisplayName(contact),
        },
        dedupeKey: `federation.contact.revoked:${contact.id}:${contact.generation}`,
        deliveryId: inbox.deliveryId,
      }, ctx);
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
  const conversation = await ensureContactConversation(contact, ctx);
  const messageId = await stableOpaqueId(
    "msg",
    [contact.id, contact.generation, inbox.deliveryId],
  );
  const resources = validateFederationResourceDescriptors(payload.resources);
  const media = resources?.map((resource) => localizeResource(contact, resource));
  const appended = await getConversationById(ctx.installationId, conversation.id).append({
    messageId,
    idempotencyKey: `federation:${contact.id}:${contact.generation}:${inbox.deliveryId}`,
    author: contactAuthor(contact),
    text: payload.text,
    ...(media?.length ? { media } : undefined),
    ...(media?.length
      ? { mediaAuthority: { kind: "federation", target: contact.id } as const }
      : undefined),
    origin: { kind: "federation", contactId: contact.id, deliveryId: inbox.deliveryId },
    createdAt: inbox.receivedAtMs,
  });
  ctx.conversations.recordSequence(conversation.id, appended.message.sequence);
  if (appended.created) broadcastCommittedMessage(contact.ownerUid, appended.message, ctx);
  if (ctx.responsibilitySources.isEnabled(contact.ownerUid, "federation.received")) {
    createFederationResponsibility({
      ownerUid: contact.ownerUid,
      title: `Review contact message ${messageId} with the owner`,
      details: {
        eventType: "federation.message.received",
        contactId: contact.id,
        contactGeneration: contact.generation,
        conversationId: conversation.id,
        messageId,
        deliveryId: inbox.deliveryId,
        remoteDisplayName: contactDisplayName(contact),
        resourceCount: media?.length ?? 0,
        contentTrust: "untrusted",
      },
      dedupeKey: `federation.message:${contact.id}:${contact.generation}:${inbox.deliveryId}`,
      deliveryId: inbox.deliveryId,
      conversationId: conversation.id,
    }, ctx);
    await ctx.reconcileResponsibilityWake(contact.ownerUid);
  }
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
        createdAtMs: inbox.receivedAtMs,
        updatedAtMs: inbox.receivedAtMs,
      });
      syncFederationRequestResponsibility({
        request: created,
        contact,
        conversationId: conversation.id,
        deliveryId: inbox.deliveryId,
        remoteInput: true,
        createAllowed: ctx.responsibilitySources.isEnabled(
          contact.ownerUid,
          "federation.received",
        ),
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
  const conversation = await ensureContactConversation(contact, ctx);
  const updated = ctx.federation.transaction(() => {
    const latest = ctx.federation.requestForRemoteUpdate(
      contact.id,
      contact.generation,
      payload.requestId,
    );
    if (!latest) throw new PublicFederationError(404, "Contact request not found");
    const alreadyApplied = latest.revision === payload.expectedRevision + 1
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
      if (!isRequestTransitionAllowed(latest.state, payload.state)) {
        throw new PublicFederationError(
          409,
          `Contact request cannot change from ${latest.state} to ${payload.state}`,
        );
      }
      next = ctx.federation.updateRequest({
        requestId: latest.id,
        expectedRevision: payload.expectedRevision,
        state: payload.state,
        ...(details ? { details } : undefined),
        updatedAtMs: receivedAtMs,
      });
    }
    syncFederationRequestResponsibility({
      request: next,
      contact,
      conversationId: conversation.id,
      deliveryId: inbox.deliveryId,
      remoteInput: true,
      createAllowed: ctx.responsibilitySources.isEnabled(
        contact.ownerUid,
        "federation.received",
      ),
      now: receivedAtMs,
    }, ctx);
    return next;
  });
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

async function serveRemoteResource(request: Request, ctx: KernelContext): Promise<Response> {
  const url = new URL(request.url);
  const resourceId = decodeURIComponent(url.pathname.slice(RESOURCE_PATH_PREFIX.length));
  if (!resourceId.startsWith("resource:")) {
    throw new PublicFederationError(404, "Resource not found");
  }
  const headers = resourceRequestHeadersSchema.parse({
    senderShipId: request.headers.get("x-gsv-sender-ship"),
    senderSubjectId: request.headers.get("x-gsv-sender-subject"),
    recipientSubjectId: request.headers.get("x-gsv-recipient-subject"),
    generation: request.headers.get("x-gsv-contact-generation"),
    timestampMs: request.headers.get("x-gsv-timestamp"),
    nonce: request.headers.get("x-gsv-nonce"),
    signature: request.headers.get("x-gsv-signature"),
  });
  assertCurrentTimestamp(headers.timestampMs);
  const contact = ctx.federation.getForInbound(
    headers.senderShipId,
    headers.senderSubjectId,
    headers.recipientSubjectId,
  );
  if (
    !contact
    || contact.state !== "active"
    || contact.generation !== headers.generation
  ) {
    throw new PublicFederationError(404, "Resource not found");
  }
  const requestFields = {
    version: 1,
    method: "GET",
    path: url.pathname,
    senderShipId: headers.senderShipId,
    senderSubjectId: headers.senderSubjectId,
    recipientSubjectId: headers.recipientSubjectId,
    generation: headers.generation,
    timestampMs: headers.timestampMs,
    nonce: headers.nonce,
  };
  if (!await verifyContactEnvelope(
    contact.sharedSecret,
    jsonValue(requestFields),
    headers.signature,
  )) {
    throw new PublicFederationError(404, "Resource not found");
  }
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
    if (!isCurrentFederationResource(contact.id, contact.generation, resourceId, ctx)) {
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
    const responseFields = {
      version: 1,
      resourceId,
      requestNonce: headers.nonce,
      size: result.size,
      revision: result.revision ?? grant.source.ref.revision,
      contentType: result.contentType ?? grant.source.ref.contentType,
    };
    const signature = await signContactEnvelope(contact.sharedSecret, jsonValue(responseFields));
    if (!isCurrentFederationResource(contact.id, contact.generation, resourceId, ctx)) {
      throw new PublicFederationError(404, "Resource not found");
    }
    return new Response(federationContactStream(
      response.body.stream,
      () => isCurrentFederationResource(contact.id, contact.generation, resourceId, ctx),
      () => ctx.federation.finishResourceRead(readId),
    ), {
      status: 200,
      headers: {
        "content-type": responseFields.contentType,
        "content-length": String(responseFields.size),
        "cache-control": "private, no-store",
        "x-gsv-resource-size": String(responseFields.size),
        "x-gsv-resource-revision": responseFields.revision,
        "x-gsv-resource-signature": signature,
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
  const identity: ConnectionIdentity = {
    role: "user",
    process,
    capabilities: ctx.caps.resolve(process.gids),
  };
  return await handleFsTransferSend({
    path: grant.source.ref.path,
    revision: grant.source.ref.revision,
  }, {
    ...ctx,
    identity,
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
  const process = ctx.procs.get(conversation.handlerPid);
  if (!process) throw new Error("Contact conversation handler is unavailable");
  const appended = await getConversationById(ctx.installationId, conversation.id).append({
    messageId: local.messageId,
    idempotencyKey: `federation-local:${outbox.deliveryId}`,
    author: local.author,
    text: local.text,
    media: local.media,
    ...(local.media?.length
      ? { mediaOwner: processMediaOwner(conversation.handlerPid, process) }
      : undefined),
    origin: local.origin,
    processId: local.processId,
    runId: local.runId,
    createdAt: local.createdAtMs,
  });
  ctx.federation.markLocalMessageCommitted(outbox.deliveryId, appended.message.sequence);
  ctx.conversations.recordSequence(conversation.id, appended.message.sequence);
  if (appended.created) broadcastCommittedMessage(contact.ownerUid, appended.message, ctx);
}

async function ensureContactConversation(
  contact: FederationContactRecord,
  ctx: KernelContext,
) {
  const handlerPid = await ensurePersonalController(contact.ownerUid, ctx);
  const conversation = ctx.conversations.ensureContact(
    contact.ownerUid,
    handlerPid,
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
  ctx.conversations.recordSequence(conversationId, appended.message.sequence);
  if (appended.created) broadcastCommittedMessage(contact.ownerUid, appended.message, ctx);
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
  handlerPid: string;
  ownerUid: number;
  contact: FederationContactRecord;
  deliveryId: string;
  ctx: KernelContext;
  now: number;
}): FederationOutboxLocalMessage {
  let author: ConversationMessageAuthor;
  let origin: ConversationMessageOrigin;
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
    media: input.media,
    author,
    origin,
    processId: input.handlerPid,
    createdAtMs: input.now,
  };
}

function contactAuthor(contact: FederationContactRecord): ConversationMessageAuthor {
  return {
    kind: "contact",
    contactId: contact.id,
    shipId: contact.remoteShipId,
    subjectId: contact.remoteSubject.id,
    displayName: contact.remoteSubject.displayName,
  };
}

function broadcastCommittedMessage(
  ownerUid: number,
  message: ConversationMessage,
  ctx: KernelContext,
): void {
  ctx.broadcastToUserUid(ownerUid, "message.committed", { message, directed: false });
  ctx.broadcastToUserUid(ownerUid, "conversation.changed", {
    conversationId: message.conversationId,
    latestSequence: message.sequence,
  });
}

async function localShipDocument(ctx: KernelContext): Promise<FederationShipDocument> {
  const origin = ctx.installationIdentity?.canonicalOrigin;
  if (!origin) throw new Error("Installation has no canonical origin for federation");
  return await ctx.federationIdentity.ensure(origin);
}

function ensureLocalSubject(ownerUid: number, ctx: KernelContext): FederationSubject {
  const account = ctx.auth.getPasswdByUid(ownerUid);
  if (!account) throw new Error("Contact owner account is unavailable");
  return ctx.federation.ensureSubject(
    ownerUid,
    boundedText(account.username, "Contact display name", MAX_CONTACT_DISPLAY_NAME_BYTES, false),
  );
}

function requireContactCaller(ctx: KernelContext, directHuman: boolean): number {
  if (ctx.identity?.role !== "user") throw new Error("Contact operations require a user");
  const ownerUid = resolveCallerOwnerUid(ctx);
  if (directHuman) {
    const process = ctx.processId ? ctx.procs.get(ctx.processId) : null;
    const ownShip = process?.isPersonalController === true && process.ownerUid === ownerUid;
    const directClient = Boolean(ctx.connection && !ctx.processId);
    if (!directClient && !ownShip) {
      throw new Error("This contact operation requires a signed-in human or their Ship");
    }
    const account = ctx.auth.getPasswdByUid(ownerUid);
    const shadow = account ? ctx.auth.getShadowByUsername(account.username) : null;
    if (
      !account
      || ownerUid < 1_000
      || ctx.auth.isPersonalAgentUid(ownerUid)
      || !shadow
      || isLocked(shadow)
    ) {
      throw new Error("This contact operation requires a signed-in human or their Ship");
    }
  }
  return ownerUid;
}

function requireOwnedActiveContact(
  contactIdValue: string,
  ownerUid: number,
  ctx: KernelContext,
): FederationContactRecord {
  const contactId = contactIdValue.trim();
  const contact = ctx.federation.get(contactId);
  if (!contact || contact.ownerUid !== ownerUid || contact.state !== "active") {
    throw new Error(`Contact not found: ${contactId}`);
  }
  return contact;
}

function requireOwnedActiveContactGeneration(
  expected: FederationContactRecord,
  ownerUid: number,
  ctx: KernelContext,
): FederationContactRecord {
  const current = requireOwnedActiveContact(expected.id, ownerUid, ctx);
  if (current.generation !== expected.generation) {
    throw new Error("Contact generation changed during operation");
  }
  return current;
}

function requireOwnedContact(
  contactIdValue: string,
  ownerUid: number,
  ctx: KernelContext,
): FederationContactRecord {
  const contactId = contactIdValue.trim();
  const contact = ctx.federation.get(contactId);
  if (!contact || contact.ownerUid !== ownerUid) {
    throw new Error(`Contact not found: ${contactId}`);
  }
  return contact;
}

function contactSummary(contact: FederationContactRecord): ContactSummary {
  return {
    id: contact.id,
    ownerUid: contact.ownerUid,
    state: contact.state,
    generation: contact.generation,
    remoteShipId: contact.remoteShipId,
    remoteSubject: contact.remoteSubject,
    remoteOrigin: contact.remoteOrigin,
    ...(contact.localAlias !== undefined ? { localAlias: contact.localAlias } : undefined),
    conversationId: contact.conversationId,
    createdAtMs: contact.createdAtMs,
    updatedAtMs: contact.updatedAtMs,
    ...(contact.revokedAtMs !== undefined ? { revokedAtMs: contact.revokedAtMs } : undefined),
    ...(contact.lastReceivedAtMs !== undefined
      ? { lastReceivedAtMs: contact.lastReceivedAtMs }
      : undefined),
    ...(contact.lastDeliveredAtMs !== undefined
      ? { lastDeliveredAtMs: contact.lastDeliveredAtMs }
      : undefined),
  };
}

function contactInviteSummary(
  invite: FederationInviteRecord,
  now: number,
): ContactInviteSummary {
  const base = {
    inviteId: invite.inviteId,
    expiresAtMs: invite.expiresAtMs,
    createdAtMs: invite.createdAtMs,
  };
  if (invite.state === "accepted") {
    return {
      ...base,
      state: "accepted",
      acceptedAtMs: invite.acceptedAtMs,
      contactId: invite.acceptedContactId,
      remoteShipId: invite.acceptedRemoteShipId,
      remoteSubjectId: invite.acceptedRemoteSubjectId,
    };
  }
  if (invite.state === "cancelled") {
    return { ...base, state: "cancelled", cancelledAtMs: invite.cancelledAtMs };
  }
  return { ...base, state: invite.expiresAtMs <= now ? "expired" : "pending" };
}

function normalizeSubject(subject: FederationSubject): FederationSubject {
  return {
    id: subject.id,
    displayName: boundedText(
      subject.displayName,
      "Contact display name",
      MAX_CONTACT_DISPLAY_NAME_BYTES,
      false,
    ),
  };
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

function encodeInviteCode(value: z.infer<typeof inviteCodeSchema>): string {
  return `${INVITE_PREFIX}${base64UrlEncode(encoder.encode(JSON.stringify(value)))}`;
}

function decodeInviteCode(value: string): z.infer<typeof inviteCodeSchema> {
  if (!value.startsWith(INVITE_PREFIX)) throw new Error("Contact invite code is invalid");
  try {
    const encoded = value.slice(INVITE_PREFIX.length);
    return inviteCodeSchema.parse(JSON.parse(decoder.decode(base64UrlDecode(encoded))));
  } catch {
    throw new Error("Contact invite code is invalid");
  }
}

function inviteAcceptResponseUnsigned(value: InviteAcceptResponse): InviteAcceptResponseUnsigned {
  return {
    version: value.version,
    recipientShipId: value.recipientShipId,
    recipientSubjectId: value.recipientSubjectId,
    generation: value.generation,
    threadId: value.threadId,
    document: value.document,
    subject: value.subject,
  };
}

async function readBoundedJson(request: Request): Promise<JsonValue> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_PUBLIC_JSON_BYTES) {
    throw new PublicFederationError(413, "Federation request body is too large");
  }
  if (!request.body) throw new PublicFederationError(400, "Federation request body is missing");
  const bytes = await bodyToBytes(
    { stream: request.body, length: contentLength ? Number(contentLength) : undefined },
    MAX_PUBLIC_JSON_BYTES,
    request.signal,
  );
  try {
    return jsonValueSchema.parse(JSON.parse(decoder.decode(bytes)));
  } catch {
    throw new PublicFederationError(400, "Federation request body is invalid JSON");
  }
}

async function fetchJson(url: string, init: RequestInit): Promise<JsonValue> {
  const timeoutSignal = AbortSignal.timeout(30_000);
  const signal = init.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;
  const response = await fetch(url, {
    ...init,
    redirect: "manual",
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new FederationHttpError(response.status, `Remote Ship rejected the request (${response.status})`);
  }
  if (!response.body) throw new Error("Remote Ship returned an empty response");
  const lengthHeader = response.headers.get("content-length");
  const bytes = await bodyToBytes(
    {
      stream: response.body,
      length: lengthHeader ? Number(lengthHeader) : undefined,
    },
    MAX_PUBLIC_JSON_BYTES,
    signal,
  );
  return jsonValueSchema.parse(JSON.parse(decoder.decode(bytes)));
}

function jsonResponse(value: JsonValue, status = 200, extraHeaders?: HeadersInit): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store", ...Object.fromEntries(new Headers(extraHeaders)) },
  });
}

function resourceRequestHeaders(
  fields: {
    senderShipId: string;
    senderSubjectId: string;
    recipientSubjectId: string;
    generation: string;
    timestampMs: number;
    nonce: string;
  },
  signature: string,
): Headers {
  return new Headers({
    "x-gsv-sender-ship": fields.senderShipId,
    "x-gsv-sender-subject": fields.senderSubjectId,
    "x-gsv-recipient-subject": fields.recipientSubjectId,
    "x-gsv-contact-generation": fields.generation,
    "x-gsv-timestamp": String(fields.timestampMs),
    "x-gsv-nonce": fields.nonce,
    "x-gsv-signature": signature,
  });
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

function assertCurrentTimestamp(timestampMs: number): void {
  if (Math.abs(Date.now() - timestampMs) > MAX_CLOCK_SKEW_MS) {
    throw new PublicFederationError(401, "Federation request timestamp is stale");
  }
}

function publicFederationFailure(cause: unknown): PublicFederationFailure {
  if (cause instanceof PublicFederationError) {
    return {
      status: cause.status,
      message: cause.message,
      ...(cause.retryAfterMs === undefined ? undefined : { retryAfterMs: cause.retryAfterMs }),
    };
  }
  if (cause instanceof z.ZodError) {
    return { status: 400, message: "Federation request is invalid" };
  }
  console.warn(
    "[Kernel] Federation request failed:",
    cause instanceof Error ? cause.message : String(cause),
  );
  return { status: 500, message: "Federation request failed" };
}

function jsonValue<Value>(value: Value): JsonValue {
  return jsonValueSchema.parse(value);
}

function jsonObject<Value>(value: Value): JsonObject {
  return jsonObjectSchema.parse(value);
}
