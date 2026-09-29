import { isLocked } from "../auth/shadow";
import { hasCapability } from "./capabilities";
import { principalOf, type KernelContext } from "./context";

/** Pairing belongs to a credential-authenticated human, independently of transport capability. */
export function interactivePairingOwner(ctx: KernelContext): number | null {
  const identity = principalOf(ctx);
  if (!identity || identity.kind !== "human" || !ctx.connection || ctx.processId || ctx.peer?.provenance.kind !== "credential") return null;
  const uid = identity.account.uid;
  const user = ctx.auth.getPasswdByUid(uid);
  const shadow = user ? ctx.auth.getShadowByUsername(user.username) : null;
  if (!user || uid < 1000 || ctx.auth.isPersonalAgentUid(uid) || !shadow || isLocked(shadow) || ctx.auth.isAccountDisabled(uid)) return null;
  return uid;
}

export function canLinkAdapter(ctx: KernelContext): boolean {
  if (interactivePairingOwner(ctx) === null) return false;
  const calls = principalOf(ctx)!.calls;
  return ["adapter.pair.info", "adapter.pair.inspect", "adapter.pair.confirm"].every((call) => hasCapability(calls, call));
}
