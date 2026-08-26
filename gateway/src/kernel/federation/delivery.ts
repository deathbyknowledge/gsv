import type {
  ContactDeliveryStatus,
  ContactSendResult,
  JsonValue,
} from "@humansandmachines/gsv/protocol";
import type { KernelContext } from "../context";
import { canonicalJson, sha256Base64Url } from "../federation-crypto";
import type { FederationContactRecord, FederationOutboxRecord } from "../federation-store";
import { FederationHttpError } from "./errors";

export function currentFederationDeliveryContact(
  record: FederationOutboxRecord,
  ctx: KernelContext,
): FederationContactRecord | null {
  const contact = ctx.federation.get(record.contactId);
  if (
    !contact
    || contact.generation !== record.contactGeneration
    || (contact.state !== "active" && record.payload.kind !== "contact.revoked")
  ) {
    return null;
  }
  return contact;
}

export function contactSendResult(
  record: FederationOutboxRecord,
  contact: FederationContactRecord,
): ContactSendResult {
  return {
    deliveryId: record.deliveryId,
    conversationId: contact.conversationId,
    state: record.state === "terminal"
      ? "failed"
      : record.state === "delivered"
        ? "delivered"
        : "queued",
  };
}

export function contactDeliveryStatus(
  record: FederationOutboxRecord,
  contact: FederationContactRecord,
): ContactDeliveryStatus {
  return {
    deliveryId: record.deliveryId,
    contactId: record.contactId,
    conversationId: contact.conversationId,
    state: record.state === "pending"
      ? "queued"
      : record.state === "delivered"
        ? "delivered"
        : "failed",
    attemptCount: record.attemptCount,
    createdAtMs: record.createdAtMs,
    updatedAtMs: record.updatedAtMs,
    ...(record.deliveredAtMs !== undefined ? { deliveredAtMs: record.deliveredAtMs } : undefined),
    ...(record.lastError ? { lastError: record.lastError } : undefined),
  };
}

export async function federationInputFingerprint(value: JsonValue): Promise<string> {
  return await sha256Base64Url(canonicalJson(value));
}

export function assertDeliveryReplay(
  record: FederationOutboxRecord,
  contactId: string,
  contactGeneration: string,
  fingerprint: string,
): void {
  if (
    record.contactId !== contactId
    || record.contactGeneration !== contactGeneration
    || record.fingerprint !== fingerprint
  ) {
    throw new Error("Contact delivery idempotency key payload changed");
  }
}

export async function rearmPendingDelivery(
  record: FederationOutboxRecord,
  ctx: KernelContext,
): Promise<void> {
  if (record.state !== "pending") return;
  await ctx.scheduleFederationDelivery(
    record.deliveryId,
    record.nextAttemptAtMs ?? Date.now(),
    true,
  );
}

export function deliveryRetryDelayMs(attempt: number): number {
  return Math.min(60 * 60_000, 2_000 * (2 ** Math.min(10, Math.max(0, attempt - 1))));
}

export function isTerminalFederationError(cause: unknown): boolean {
  return cause instanceof FederationHttpError
    && cause.status >= 400
    && cause.status < 500
    && cause.status !== 408
    && cause.status !== 429;
}
