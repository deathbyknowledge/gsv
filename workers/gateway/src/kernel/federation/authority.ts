import type { ContactSummary } from "@humansandmachines/gsv/protocol";
import type { KernelContext } from "../context";
import { principalOf, resolveCallerOwnerUid } from "../context";
import { isLocked } from "../../auth/shadow";
import type { FederationContactRecord } from "../federation-store";

export function requireContactCaller(ctx: KernelContext, directHuman: boolean): number {
  if (principalOf(ctx)?.kind !== "human") throw new Error("Contact operations require a user");
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

export function requireOwnedActiveContact(
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

export function requireOwnedActiveContactGeneration(
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

export function requireOwnedContact(
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

export function requireContactHuman(ctx: KernelContext): number {
  if (ctx.processId || !ctx.connection) throw new Error("This contact operation requires a signed-in human");
  return requireContactCaller(ctx, true);
}

export function contactSummary(contact: FederationContactRecord): ContactSummary {
  return {
    id: contact.id,
    ownerUid: contact.ownerUid,
    state: contact.state,
    generation: contact.generation,
    remoteShipId: contact.remoteShipId,
    remoteSubject: contact.remoteSubject,
    remoteOrigin: contact.remoteOrigin,
    preferences: contact.preferences,
    blocked: contact.blocked,
    ...(contact.protocol ? { protocol: contact.protocol } : undefined),
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

