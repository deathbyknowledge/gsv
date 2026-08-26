import type { FederationShipDocument } from "@humansandmachines/gsv/protocol";
import { jsonValueSchema } from "@humansandmachines/gsv/protocol";
import type { KernelContext } from "../context";
import { canonicalJson } from "../federation-crypto";
import type {
  FederationContactRecord,
  FederationPairingAttemptRecord,
  FederationStore,
} from "../federation-store";
import { cancelRequestResponsibilities } from "./requests";

export function activateFederationContact(
  input: Parameters<FederationStore["activateContact"]>[0],
  ctx: KernelContext,
): FederationContactRecord {
  const existing = ctx.federation.getByRemote(
    input.ownerUid,
    input.remoteShipId,
    input.remoteSubject.id,
  );
  const superseded = existing && existing.generation !== input.generation
    ? ctx.federation.listRequests(input.ownerUid, existing.id)
    : [];
  const contact = ctx.federation.activateContact(input);
  cancelRequestResponsibilities(
    input.ownerUid,
    superseded,
    "contact-generation-changed",
    input.now ?? Date.now(),
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
  const revoked = ctx.federation.revoke(contact.id, contact.ownerUid, now);
  cancelRequestResponsibilities(contact.ownerUid, pending, "contact-revoked", now, ctx);
  return revoked;
}

export function assertPairingAttemptIdentity(
  attempt: FederationPairingAttemptRecord,
  expected: {
    ownerUid: number;
    expiresAtMs: number;
    remoteShipId: string;
    remoteSubjectId: string;
    remoteOrigin: string;
    remotePublicKey?: FederationShipDocument["publicKey"];
  },
): void {
  if (
    attempt.ownerUid !== expected.ownerUid
    || attempt.expiresAtMs !== expected.expiresAtMs
    || attempt.remoteShipId !== expected.remoteShipId
    || attempt.remoteSubjectId !== expected.remoteSubjectId
    || attempt.remoteOrigin !== expected.remoteOrigin
    || (
      expected.remotePublicKey
      && canonicalJson(jsonValueSchema.parse(attempt.remotePublicKey))
        !== canonicalJson(jsonValueSchema.parse(expected.remotePublicKey))
    )
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
    || contact.remoteShipId !== attempt.remoteShipId
    || contact.remoteSubject.id !== attempt.remoteSubjectId
    || contact.remoteOrigin !== attempt.remoteOrigin
    || canonicalJson(jsonValueSchema.parse(contact.remotePublicKey))
      !== canonicalJson(jsonValueSchema.parse(attempt.remotePublicKey))
  ) {
    throw new Error("Contact pairing attempt was superseded");
  }
  return contact;
}
