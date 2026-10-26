import type { KernelContext } from "../context";
import type { FederationContactRecord } from "../federation-store";
import {
  DidDeactivatedError,
  DidDirectoryUnavailableError,
  DidNotResolvedError,
  resolveDid,
  resolveHandle,
  type ResolvedDid,
} from "../ships/did-directory";
import { ShipCallError } from "../ships/errors";
import { isTerminalFederationError } from "./delivery";
import { revokeFederationContact } from "./pairing";

/** Opening a contact checks its Ship at most once in this window, on a DID document no older than it. */
const OPENED_CHECK_MS = 60 * 60_000;

/**
 * Ends a contact here when a failed delivery shows that its Ship is gone for
 * good, and says whether it did. What waited for the contact fails, nothing is
 * sent to the Ship, and the conversation stays.
 */
export async function endContactIfShipGone(contact: FederationContactRecord, failure: Error, ctx: KernelContext): Promise<boolean> {
  if (!contact.remoteDid) return false;
  let gone: boolean;
  try {
    gone = await shipGone(contact.remoteDid, failure, ctx);
  } catch (error) {
    // The delivery's failure is recorded as before; its next attempt checks again.
    console.warn("[Kernel] Couldn't tell whether a contact's Ship is gone:", error instanceof Error ? error.message : String(error));
    return false;
  }
  return gone && await endContact(contact, ctx);
}

/**
 * Once a person opens a contact or its conversation, checks whether the
 * contact's Ship is gone, as a failed delivery would but without one. The
 * check runs after the read answers, at most once an hour for each contact,
 * and a contact it ends is broadcast.
 */
export function checkContactWhenOpened(contact: FederationContactRecord, ctx: KernelContext): void {
  const did = contact.remoteDid;
  if (contact.state !== "active" || !did) return;
  if (ctx.federation.consumeRateLimits([{ scope: contact.id, operation: "ship.check", maximum: 1, windowMs: OPENED_CHECK_MS }]) !== null) return;
  // The check outlives the read, so the reader's cancellation doesn't reach it.
  const { requestSignal: _read, ...check } = ctx;
  ctx.defer((async () => {
    if (await shipGoneWhenOpened(did, check)) await endContact(contact, check);
  })().catch((cause: unknown) => {
    console.warn("[Kernel] Couldn't tell whether a contact's Ship is gone:", cause instanceof Error ? cause.message : String(cause));
  }));
}

/**
 * Ends the person's contacts whose DIDs the directory cache already knows
 * were deactivated. It reads nothing from the network, so a listing can wait
 * for it.
 */
export async function endContactsKnownGone(ownerUid: number, ctx: KernelContext): Promise<void> {
  const contacts = ctx.federation.list(ownerUid);
  const deactivated = ctx.didDocuments.deactivated(contacts.flatMap(({ remoteDid }) => remoteDid ? [remoteDid] : []));
  for (const contact of contacts) {
    if (contact.remoteDid && deactivated.has(contact.remoteDid)) await endContact(contact, ctx);
  }
}

/** Ends a contact here unless it changed since it was judged, and says whether it did. */
async function endContact(contact: FederationContactRecord, ctx: KernelContext): Promise<boolean> {
  const ended = await ctx.coordinateFederationContact(contact.id, () => ctx.federation.transaction(() => {
    const current = ctx.federation.get(contact.id);
    if (!current || current.generation !== contact.generation) return false;
    const now = Date.now();
    ctx.federation.terminatePendingForRevokedContact(current.id, current.generation, null, now);
    if (current.state === "active") revokeFederationContact(current, now, ctx);
    return true;
  }));
  if (!ended) return false;
  ctx.broadcastToUserUid(contact.ownerUid, "contact.changed");
  ctx.broadcastToUserUid(contact.ownerUid, "contact.delivery.changed", { contactId: contact.id });
  ctx.broadcastToUserUid(contact.ownerUid, "contact.request.changed", { contactId: contact.id });
  await ctx.reconcileResponsibilityWake(contact.ownerUid);
  return true;
}

/**
 * Whether a failed call proves that a DID's Ship is gone. Two signals do: the
 * DID's verified history ends in a tombstone, or the address its document
 * names refused a token addressed to it and now names another DID, checked
 * both ways, that serves its own Ship there. The document is read again first,
 * so a Ship that moved is found at its new address. A directory outage, a
 * timeout, a server error or a rate limit proves nothing, and neither does a
 * document without a Ship service, which its owner can restore.
 */
async function shipGone(did: string, failure: Error, ctx: KernelContext): Promise<boolean> {
  if (failure instanceof DidDeactivatedError) return true;
  if (!(failure instanceof ShipCallError) || !isTerminalFederationError(failure)) return false;
  const current = await documentOf(did, ctx, { refresh: true });
  if (current === "deactivated") return true;
  if (!current?.shipEndpoint || failure.error !== "BadJwtAudience") return false;
  return await addressTakenOver(did, current.shipEndpoint, ctx);
}

/**
 * Whether an opened contact's Ship is gone, by the same two signals without a
 * refusal: its DID was deactivated, by a document read again once the cached
 * one is an hour old, or the address the document names now names another DID
 * that serves its own Ship there. Ending can't be undone, so a takeover found
 * on a cached document is checked again on the directory's current one.
 */
async function shipGoneWhenOpened(did: string, ctx: KernelContext): Promise<boolean> {
  const known = await documentOf(did, ctx, { maxAgeMs: OPENED_CHECK_MS });
  if (known === "deactivated") return true;
  if (!known?.shipEndpoint || !await addressTakenOver(did, known.shipEndpoint, ctx)) return false;
  // The Ship may have moved since; the new address is judged on its own.
  const current = await documentOf(did, ctx, { refresh: true });
  if (current === "deactivated") return true;
  if (!current?.shipEndpoint) return false;
  return current.shipEndpoint === known.shipEndpoint || await addressTakenOver(did, current.shipEndpoint, ctx);
}

/** A DID's document, `"deactivated"` once its verified history ends in a tombstone, or null when the directory can't say. */
async function documentOf(did: string, ctx: KernelContext, options: { refresh?: boolean; maxAgeMs?: number }): Promise<ResolvedDid | "deactivated" | null> {
  try {
    return await resolveDid(did, ctx, options);
  } catch (error) {
    if (error instanceof DidDeactivatedError) return "deactivated";
    if (error instanceof DidNotResolvedError || error instanceof DidDirectoryUnavailableError) return null;
    throw error;
  }
}

/** Whether the address a DID's document names now names another DID, checked both ways, that serves its own Ship there. */
async function addressTakenOver(did: string, shipEndpoint: string, ctx: KernelContext): Promise<boolean> {
  const address = new URL(shipEndpoint);
  let holder: ResolvedDid;
  try {
    holder = await resolveHandle(address.hostname, ctx);
  } catch (error) {
    if (error instanceof DidNotResolvedError || error instanceof DidDirectoryUnavailableError) return false;
    throw error;
  }
  // A shared host can misroute one token, and its hostname can be another account's handle.
  return holder.did !== did && holder.shipEndpoint !== null && new URL(holder.shipEndpoint).origin === address.origin;
}
