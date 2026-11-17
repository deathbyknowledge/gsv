import type { KernelContext } from "../context";
import type {
  FederationContactRecord,
  FederationPairingAttemptRecord,
  FederationStore,
} from "../federation-store";
import { endContactHandling } from "./attention";
import { cancelRequestResponsibilities } from "./requests";

/** What the person accepting an invitation reads when the inviting Ship refuses, by the error it names. */
const REFUSALS = new Map([
  ["InvitationNotFound", "This invitation isn't available. Ask for a new one."],
  ["InvitationExpired", "This invitation has expired. Ask for a new one."],
  ["InvitationCancelled", "This invitation was cancelled."],
  ["InvitationUsed", "This invitation was already used."],
]);
const UNAVAILABLE = REFUSALS.get("InvitationNotFound")!;

/** What the person accepting reads for the XRPC error the inviting Ship refused with, when it is a known refusal. */
export function invitationRefusal(error: string | undefined): string | undefined {
  return error ? REFUSALS.get(error) : undefined;
}

/**
 * Why an attempt ends when the inviting Ship refuses it for good. The reason
 * keeps a known refusal's name, so a retry repeats it without calling again.
 */
export function remoteRejection(status: number, error: string | undefined): string {
  return invitationRefusal(error) ? `remote-rejected:${status}:${error}` : `remote-rejected:${status}`;
}

export function activateFederationContact(
  activation: Parameters<FederationStore["activateContact"]>[0],
  ctx: KernelContext,
): FederationContactRecord {
  const existing = ctx.federation.getByRemote(activation.ownerUid, activation.remoteDid);
  const superseded = existing && existing.generation !== activation.generation
    ? ctx.federation.listRequests(activation.ownerUid, existing.id)
    : [];
  if (existing && existing.generation !== activation.generation && endContactHandling(existing, ctx)) ctx.defer(ctx.reconcileResponsibilityWake(existing.ownerUid));
  const contact = ctx.federation.activateContact(activation);
  cancelRequestResponsibilities(
    activation.ownerUid,
    superseded,
    "contact-generation-changed",
    activation.now ?? Date.now(),
    ctx,
  );
  return contact;
}

export function revokeFederationContact(
  contact: FederationContactRecord,
  now: number,
  ctx: KernelContext,
): FederationContactRecord {
  const pending = ctx.federation.listRequests(contact.ownerUid, contact.id);
  if (endContactHandling(contact, ctx)) ctx.defer(ctx.reconcileResponsibilityWake(contact.ownerUid));
  const revoked = ctx.federation.revoke(contact.id, contact.ownerUid, now);
  cancelRequestResponsibilities(contact.ownerUid, pending, "contact-revoked", now, ctx);
  return revoked;
}

export function assertPairingAttemptIdentity(
  attempt: FederationPairingAttemptRecord,
  expected: { ownerUid: number; expiresAtMs: number; remoteDid: string },
): void {
  if (
    attempt.ownerUid !== expected.ownerUid
    || attempt.expiresAtMs !== expected.expiresAtMs
    || attempt.remoteDid !== expected.remoteDid
  ) {
    throw new Error("Contact pairing attempt identity changed");
  }
}

export function assertPairingAttemptCanContinue(
  attempt: FederationPairingAttemptRecord,
): asserts attempt is Exclude<FederationPairingAttemptRecord, { state: "terminal" }> {
  if (attempt.state !== "terminal") return;
  if (attempt.terminalReason === "superseded") {
    throw new Error("Contact pairing attempt was superseded");
  }
  const [cause, , refusal] = attempt.terminalReason.split(":");
  // A refusal without a name the person can read says the invitation isn't available.
  if (cause === "remote-rejected") throw new Error(invitationRefusal(refusal) ?? UNAVAILABLE);
  throw new Error(`Contact pairing attempt is terminal (${attempt.terminalReason})`);
}

export function requireCommittedPairingContact(
  attempt: Extract<FederationPairingAttemptRecord, { state: "committed" }>,
  ctx: KernelContext,
): FederationContactRecord {
  const contact = ctx.federation.get(attempt.contactId);
  if (
    !contact
    || contact.ownerUid !== attempt.ownerUid
    || contact.state !== "active"
    || contact.generation !== attempt.generation
    || contact.threadId !== attempt.threadId
    || contact.remoteDid !== attempt.remoteDid
  ) {
    throw new Error("Contact pairing attempt was superseded");
  }
  return contact;
}
