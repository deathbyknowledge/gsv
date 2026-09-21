import type { ActorRef, ApproachContent, ApproachRef, FederationPublicKey, FederationShipDocumentV2 } from "@humansandmachines/gsv/protocol";
import { federationShipDocumentV2Schema, jsonValueSchema } from "@humansandmachines/gsv/protocol";
import type { KernelContext } from "../context";
import type { ApproachRecord } from "../approach-store";
import { canonicalJson, sha256Base64Url, verifySignedValue } from "../federation-crypto";
import { fetchFederationJson } from "../federation/http";
import { SHIP_DOCUMENT_V2_PATH, verifyShipDocumentV2 } from "../federation/protocol";
import { PublicFederationError } from "../federation/errors";
import { profileOwnerActive } from "../profiles";

export const APPROACH_PATH = "/_gsv/federation/v2/approaches";
export const APPROACH_CLAIM_PATH = `${APPROACH_PATH}/claim`;
export const APPROACH_CONFIRM_PATH = `${APPROACH_PATH}/confirm`;
export const APPROACH_WITHDRAW_PATH = `${APPROACH_PATH}/withdraw`;

export function sameActor(a: ActorRef, b: ActorRef): boolean {
  return a.shipId === b.shipId && a.subjectId === b.subjectId;
}

export function sameApproach(a: ApproachRef, b: ApproachRef): boolean {
  return sameActor(a.actor, b.actor) && a.approachId === b.approachId;
}

export function approachLock(record: ApproachRecord): string {
  return `pairing:${record.ownerUid}:${record.summary.peer.shipId}:${record.summary.peer.subjectId}`;
}

export async function approachFingerprint(content: ApproachContent, tokenHash: string): Promise<string> {
  return sha256Base64Url(canonicalJson(jsonValueSchema.parse({ content, tokenHash })));
}

export async function signApproachValue<T extends object>(value: T, ctx: KernelContext): Promise<T & { signature: string }> {
  return { ...value, signature: await ctx.federationIdentity.sign(jsonValueSchema.parse(value)) };
}

export async function verifyApproachValue(value: { signature: string }, key: FederationPublicKey): Promise<void> {
  const { signature, ...unsigned } = value;
  if (!await verifySignedValue(key, jsonValueSchema.parse(unsigned), signature)) throw new PublicFederationError(403, "Message request authentication failed");
}

export async function authenticateApproachPeer(
  packet: { document: FederationShipDocumentV2; signature: string },
  actor: ActorRef,
  ctx: KernelContext,
  pinned?: ApproachRecord,
): Promise<void> {
  await verifyShipDocumentV2(packet.document);
  if (actor.shipId !== packet.document.shipId) throw new PublicFederationError(403, "Message request authentication failed");
  await verifyApproachValue(packet, packet.document.publicKey);
  if (pinned) {
    if (!sameActor(actor, pinned.summary.peer) || packet.document.origin !== pinned.remoteOrigin
      || canonicalJson(jsonValueSchema.parse(packet.document.publicKey)) !== canonicalJson(jsonValueSchema.parse(pinned.remotePublicKey))) {
      throw new PublicFederationError(403, "Message request authentication failed");
    }
    return;
  }
  const served = federationShipDocumentV2Schema.parse(await fetchFederationJson(`${packet.document.origin}${SHIP_DOCUMENT_V2_PATH}`, {
    method: "POST", headers: { accept: "application/json" }, signal: ctx.requestSignal,
  }, ctx));
  await verifyShipDocumentV2(served);
  if (served.origin !== packet.document.origin || served.shipId !== actor.shipId
    || canonicalJson(jsonValueSchema.parse(served.publicKey)) !== canonicalJson(jsonValueSchema.parse(packet.document.publicKey))) {
    throw new PublicFederationError(403, "Message request authentication failed");
  }
}

export function requireApproachAvailable(record: ApproachRecord, ctx: KernelContext): ApproachRecord {
  const current = ctx.approaches.get(record.summary.id);
  if (!current || !profileOwnerActive(current.ownerUid, ctx)
    || ctx.federation.isActorBlocked(current.ownerUid, current.summary.peer)
    || ["blocked", "declined", "withdrawn", "expired"].includes(current.summary.state)) {
    throw new PublicFederationError(410, "Message request is no longer available");
  }
  return current;
}
