import { isLocked } from "../auth/shadow";
import { hasCapability } from "./capabilities";
import { principalOf, type KernelContext } from "./context";

/** Pairing belongs to a credential-authenticated human, independently of transport capability. */
export function interactivePairingOwner(ctx: KernelContext): number | null {
  const identity = principalOf(ctx);
  if (!identity || identity.kind !== "human" || !ctx.connection || ctx.processId || ctx.peer?.provenance.kind !== "credential") return null;
  return activeHumanOwner(ctx, identity.account.uid);
}

export function adapterPairingOwner(ctx: KernelContext): number | null {
  if (!ctx.processId) return interactivePairingOwner(ctx);
  const provenance = ctx.peer?.provenance;
  if (principalOf(ctx)?.kind !== "human" || provenance?.kind !== "process-registry" || provenance.processId !== ctx.processId) return null;
  const uid = ctx.procs.getOwnerUid(ctx.processId);
  return uid === null ? null : activeHumanOwner(ctx, uid);
}

function activeHumanOwner(ctx: KernelContext, uid: number): number | null {
  const user = ctx.auth.getPasswdByUid(uid);
  const shadow = user ? ctx.auth.getShadowByUsername(user.username) : null;
  if (!user || uid < 1000 || ctx.auth.isPersonalAgentUid(uid) || !shadow || isLocked(shadow) || ctx.auth.isAccountDisabled(uid)) return null;
  return uid;
}

export function canLinkAdapter(ctx: KernelContext): boolean {
  if (adapterPairingOwner(ctx) === null) return false;
  const calls = principalOf(ctx)!.calls;
  return ["adapter.pair.info", "adapter.pair.inspect", "adapter.pair.confirm"].every((call) => hasCapability(calls, call));
}
