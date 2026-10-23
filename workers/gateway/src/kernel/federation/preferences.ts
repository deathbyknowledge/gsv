import type {
  ContactPreferencesUpdateArgs, ContactPreferencesUpdateResult,
  ContactBlockSetArgs, ContactBlockSetResult, ContactBlockListArgs, ContactBlockListResult,
} from "@humansandmachines/gsv/protocol";
import { contactPreferencesPatchSchema, didSchema } from "@humansandmachines/gsv/protocol";
import { z } from "zod/mini";
import type { KernelContext } from "../context";
import { contactSummary, requireContactCaller, requireContactHuman } from "./authority";
import { cancelContactHandling } from "./attention";
import { revokeFederationContact } from "./pairing";

export async function handleContactPreferencesUpdate(args: ContactPreferencesUpdateArgs, ctx: KernelContext): Promise<ContactPreferencesUpdateResult> {
  const ownerUid = requireContactCaller(ctx, true);
  if (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 1) throw new Error("Contact policy revision is invalid");
  const patch = contactPreferencesPatchSchema.parse(args.patch);
  let handlingChanged = false;
  const contact = await ctx.coordinateFederationContact(args.contactId, () => ctx.federation.transaction(() => {
    const previous = ctx.federation.get(args.contactId);
    const current = ctx.federation.updatePreferences(ownerUid, { ...args, patch });
    handlingChanged = previous?.preferences.shipHandlesMessages !== current.preferences.shipHandlesMessages;
    if (handlingChanged && current.preferences.shipHandlesMessages && (current.state !== "active" || current.blocked)) {
      throw new Error("Only an active contact can enable Ship replies");
    }
    if (handlingChanged && !current.preferences.shipHandlesMessages) cancelContactHandling(current, ctx);
    return current;
  }));
  if (handlingChanged && !contact.preferences.shipHandlesMessages) await ctx.reconcileResponsibilityWake(ownerUid);
  if (contact.preferences.revision !== args.expectedRevision) ctx.broadcastToUserUid(ownerUid, "contact.changed");
  return { contact: contactSummary(contact) };
}

export async function handleContactBlockSet(args: ContactBlockSetArgs, ctx: KernelContext): Promise<ContactBlockSetResult> {
  const ownerUid = requireContactHuman(ctx);
  const did = didSchema.parse(args.did);
  const blocked = z.boolean().parse(args.blocked);
  const contact = ctx.federation.getByRemote(ownerUid, did);
  const result = await ctx.coordinateFederationContact(contact?.id ?? `pairing:${ownerUid}:${did}`, () => ctx.federation.transaction(() => {
    const displayName = contact?.localAlias ?? contact?.remoteName ?? ctx.approaches.lastDisplayName(ownerUid, did);
    const outcome = ctx.federation.setBlock(ownerUid, did, blocked, Date.now(), displayName);
    if (blocked) {
      ctx.approaches.blockForDid(ownerUid, did);
      const current = ctx.federation.getByRemote(ownerUid, did);
      if (current?.state === "active") {
        const now = Date.now();
        ctx.federation.terminatePendingForRevokedContact(current.id, current.generation, null, now);
        revokeFederationContact(current, now, ctx);
      }
    }
    return outcome;
  }));
  if (result.changed) {
    ctx.broadcastToUserUid(ownerUid, "contact.changed");
    await ctx.reconcileResponsibilityWake(ownerUid);
  }
  return { block: result.block };
}

export function handleContactBlockList(args: ContactBlockListArgs, ctx: KernelContext): ContactBlockListResult {
  const ownerUid = requireContactCaller(ctx, false);
  const limit = args.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error("Block list limit must be between 1 and 200");
  return ctx.federation.listBlocks(ownerUid, limit, args.cursor ? didSchema.parse(args.cursor) : undefined,
    args.did ? didSchema.parse(args.did) : undefined);
}
