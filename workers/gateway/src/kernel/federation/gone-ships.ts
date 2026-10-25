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
  if (!gone) return false;
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
  let current: ResolvedDid;
  try {
    current = await resolveDid(did, ctx, { refresh: true });
  } catch (error) {
    if (error instanceof DidDeactivatedError) return true;
    if (error instanceof DidNotResolvedError || error instanceof DidDirectoryUnavailableError) return false;
    throw error;
  }
  if (failure.error !== "BadJwtAudience" || !current.shipEndpoint) return false;
  const address = new URL(current.shipEndpoint);
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
