import type { FederationDeliveryEnvelope } from "@humansandmachines/gsv/protocol";
import type { KernelContext } from "../context";
import type { FederationContactRecord, FederationRateLimit } from "../federation-store";
import { PublicFederationError } from "./errors";

const MAX_CONTACTS_PER_OWNER = 1_000;
const MAX_CONTACTS_PER_INSTALLATION = 1_000;
const MAX_PENDING_OUTBOX_PER_CONTACT = 50;
const MAX_PENDING_OUTBOX_PER_OWNER = 250;
const MAX_PENDING_OUTBOX_PER_INSTALLATION = 500;
const MAX_RETAINED_OUTBOX_PER_OWNER = 20_000;
const MAX_RETAINED_OUTBOX_PER_INSTALLATION = 100_000;
const MAX_PENDING_INBOX_PER_CONTACT = 25;
const MAX_PENDING_INBOX_PER_INSTALLATION = 250;
const MAX_RETAINED_INBOX_PER_CONTACT = 20_000;
const MAX_RETAINED_INBOX_PER_INSTALLATION = 100_000;
const MAX_DELIVERIES_PER_CONTACT_PER_MINUTE = 60;
const MAX_DELIVERIES_PER_OWNER_PER_MINUTE = 300;
const MAX_DELIVERIES_PER_INSTALLATION_PER_MINUTE = 600;
const MAX_ACTIVE_REQUESTS_PER_CONTACT = 100;
const MAX_RETAINED_REQUESTS_PER_CONTACT = 5_000;
const RATE_WINDOW_MS = 60_000;
export const RECEIPT_RETENTION_MS = 8 * 24 * 60 * 60_000;
const REQUEST_RETENTION_MS = 90 * 24 * 60 * 60_000;
const RETENTION_PRUNE_BATCH = 1_000;

export function pruneFederationState(ctx: KernelContext, now: number): void {
  ctx.federation.prune({
    now,
    receiptCutoff: now - RECEIPT_RETENTION_MS,
    requestCutoff: now - REQUEST_RETENTION_MS,
    batchSize: RETENTION_PRUNE_BATCH,
  });
}

export function assertContactCapacity(
  ownerUid: number,
  remoteShipId: string | undefined,
  remoteSubjectId: string | undefined,
  ctx: KernelContext,
  publicRequest = false,
): void {
  if (
    remoteShipId
    && remoteSubjectId
    && ctx.federation.getByRemote(ownerUid, remoteShipId, remoteSubjectId)
  ) {
    return;
  }
  if (
    ctx.federation.contactCount(ownerUid) >= MAX_CONTACTS_PER_OWNER
    || ctx.federation.contactCount() >= MAX_CONTACTS_PER_INSTALLATION
  ) {
    if (publicRequest) throw new PublicFederationError(429, "Contact limit reached");
    throw new Error("Contact limit reached");
  }
}

export function assertOutboundCapacity(
  ownerUid: number,
  contactId: string,
  ctx: KernelContext,
  now: number,
): void {
  if (
    ctx.federation.pendingOutboxCount({ contactId }) >= MAX_PENDING_OUTBOX_PER_CONTACT
    || ctx.federation.pendingOutboxCount({ ownerUid }) >= MAX_PENDING_OUTBOX_PER_OWNER
    || ctx.federation.pendingOutboxCount() >= MAX_PENDING_OUTBOX_PER_INSTALLATION
  ) {
    throw new Error("Contact delivery backlog limit reached");
  }
  const cutoff = now - RECEIPT_RETENTION_MS;
  if (
    ctx.federation.retainedOutboxCount({ ownerUid, receiptCutoff: cutoff })
      >= MAX_RETAINED_OUTBOX_PER_OWNER
    || ctx.federation.retainedOutboxCount({ receiptCutoff: cutoff })
      >= MAX_RETAINED_OUTBOX_PER_INSTALLATION
  ) {
    throw new Error("Contact delivery retention limit reached");
  }
}

export function consumeOutboundDeliveryRate(
  ownerUid: number,
  contactId: string,
  ctx: KernelContext,
  now: number,
): void {
  consumeLocalRateLimits(ctx, [
    contactDeliveryRate(contactId, "outbound", MAX_DELIVERIES_PER_CONTACT_PER_MINUTE),
    contactDeliveryRate(`owner:${ownerUid}`, "outbound", MAX_DELIVERIES_PER_OWNER_PER_MINUTE),
    contactDeliveryRate(
      "installation",
      "outbound",
      MAX_DELIVERIES_PER_INSTALLATION_PER_MINUTE,
    ),
  ], now, "Contact delivery rate limit reached");
}

export function assertInboundCapacity(
  contact: FederationContactRecord,
  payload: FederationDeliveryEnvelope["payload"],
  ctx: KernelContext,
  now: number,
): void {
  if (
    ctx.federation.pendingInboxCount(contact.id) >= MAX_PENDING_INBOX_PER_CONTACT
    || ctx.federation.pendingInboxCount() >= MAX_PENDING_INBOX_PER_INSTALLATION
  ) {
    throw new PublicFederationError(429, "Federation inbox backlog limit reached");
  }
  const cutoff = now - RECEIPT_RETENTION_MS;
  if (
    ctx.federation.retainedInboxCount(contact.id, cutoff) >= MAX_RETAINED_INBOX_PER_CONTACT
    || ctx.federation.retainedInboxCount(undefined, cutoff)
      >= MAX_RETAINED_INBOX_PER_INSTALLATION
  ) {
    throw new PublicFederationError(429, "Federation inbox retention limit reached");
  }
  if (payload.kind === "request") assertRequestCapacity(contact.id, ctx, true, now);
}

export function consumeInboundDeliveryRate(
  contact: FederationContactRecord,
  ctx: KernelContext,
  now: number,
): void {
  consumePublicRateLimits(ctx, [
    contactDeliveryRate(contact.id, "inbound", MAX_DELIVERIES_PER_CONTACT_PER_MINUTE),
    contactDeliveryRate(
      `owner:${contact.ownerUid}`,
      "inbound",
      MAX_DELIVERIES_PER_OWNER_PER_MINUTE,
    ),
    contactDeliveryRate(
      "installation",
      "inbound",
      MAX_DELIVERIES_PER_INSTALLATION_PER_MINUTE,
    ),
  ], now, "Federation delivery rate limit reached");
}

export function consumeLocalRateLimits(
  ctx: KernelContext,
  limits: FederationRateLimit[],
  now: number,
  message: string,
): void {
  const retryAt = ctx.federation.consumeRateLimits(limits, now);
  if (retryAt !== null) {
    throw new Error(`${message}; retry after ${new Date(retryAt).toISOString()}`);
  }
}

export function assertRequestCapacity(
  contactId: string,
  ctx: KernelContext,
  publicRequest = false,
  now = Date.now(),
): void {
  const limited = ctx.federation.requestCount({ contactId, activeOnly: true })
      >= MAX_ACTIVE_REQUESTS_PER_CONTACT
    || ctx.federation.requestCount({
      contactId,
      requestCutoff: now - REQUEST_RETENTION_MS,
    }) >= MAX_RETAINED_REQUESTS_PER_CONTACT;
  if (!limited) return;
  if (publicRequest) throw new PublicFederationError(429, "Contact request limit reached");
  throw new Error("Contact request limit reached");
}

function contactDeliveryRate(
  scope: string,
  direction: "inbound" | "outbound",
  maximum: number,
): FederationRateLimit {
  return {
    scope,
    operation: `delivery.${direction}`,
    maximum,
    windowMs: RATE_WINDOW_MS,
  };
}

export function consumePublicRateLimits(
  ctx: KernelContext,
  limits: FederationRateLimit[],
  now: number,
  message: string,
): void {
  const retryAt = ctx.federation.consumeRateLimits(limits, now);
  if (retryAt !== null) throw new PublicFederationError(429, message, retryAt - now);
}
