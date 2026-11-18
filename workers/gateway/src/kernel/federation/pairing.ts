import type { KernelContext } from "../context";
import type { FederationContactRecord, FederationStore } from "../federation-store";
import { endContactHandling } from "./attention";
import { cancelRequestResponsibilities } from "./requests";

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
