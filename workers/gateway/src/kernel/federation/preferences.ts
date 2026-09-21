import type {
  ContactPreferencesUpdateArgs, ContactPreferencesUpdateResult,
  ContactBlockSetArgs, ContactBlockSetResult, ContactBlockListArgs, ContactBlockListResult,
} from "@humansandmachines/gsv/protocol";
import { actorRefSchema, contactPreferencesPatchSchema } from "@humansandmachines/gsv/protocol";
import type { KernelContext } from "../context";
import { contactSummary, requireContactCaller, requireContactHuman } from "./authority";
import { revokeFederationContact } from "./pairing";

export function handleContactPreferencesUpdate(args: ContactPreferencesUpdateArgs, ctx: KernelContext): ContactPreferencesUpdateResult {
  const ownerUid = requireContactHuman(ctx);
  if (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 1) throw new Error("Contact policy revision is invalid");
  const patch = contactPreferencesPatchSchema.parse(args.patch);
  const contact = ctx.federation.transaction(() => ctx.federation.updatePreferences(ownerUid, { ...args, patch }));
  if (contact.preferences.revision !== args.expectedRevision) ctx.broadcastToUserUid(ownerUid, "contact.changed");
  return { contact: contactSummary(contact) };
}

export async function handleContactBlockSet(args: ContactBlockSetArgs, ctx: KernelContext): Promise<ContactBlockSetResult> {
  const ownerUid = requireContactHuman(ctx);
  const actor = actorRefSchema.parse(args.actor);
  if (typeof args.blocked !== "boolean") throw new Error("Blocked state must be a boolean");
  const contact = ctx.federation.getByRemote(ownerUid, actor.shipId, actor.subjectId);
  const result = await ctx.coordinateFederationContact(contact?.id ?? `pairing:${ownerUid}:${actor.shipId}:${actor.subjectId}`, () => ctx.federation.transaction(() => {
    const outcome = ctx.federation.setActorBlock(ownerUid, actor, args.blocked);
    if (args.blocked) {
      const current = ctx.federation.getByRemote(ownerUid, actor.shipId, actor.subjectId);
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
  return ctx.federation.listActorBlocks(ownerUid, limit, args.cursor ? actorRefSchema.parse(args.cursor) : undefined);
}
