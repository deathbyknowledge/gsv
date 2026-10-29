import type { InstallationPhone, PhoneActor } from "@humansandmachines/gsv/services/phone";
import { principalOf, resolveCallerOwnerUid, type KernelContext } from "./context";
import { raceWithAbort } from "../shared/abort";

/** The owner and acting Process come from the Kernel, never from syscall arguments. */
export function phoneActor(ctx: KernelContext): PhoneActor {
  const principal = principalOf(ctx);
  if (principal?.kind !== "human" || !principal.account) throw new Error("Phone calls require a human owner");
  const actor: PhoneActor = { ownerUid: resolveCallerOwnerUid(ctx), human: !ctx.processId && !ctx.toolOwner };
  if (ctx.processId) actor.processId = ctx.processId;
  return actor;
}

export async function acquirePhone(ctx: KernelContext, signal?: AbortSignal): Promise<InstallationPhone> {
  if (!ctx.env.PHONE) throw new Error("Phone calls are not configured for this Ship");
  return raceWithAbort(ctx.env.PHONE.getInstallation(ctx.installationId), signal, {
    onLateResolve: service => service[Symbol.dispose]?.(),
  });
}

export async function withPhone<T>(
  ctx: KernelContext,
  work: (service: InstallationPhone, signal: AbortSignal) => Promise<T>,
  timeoutMs = 30000,
): Promise<T> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = ctx.requestSignal ? AbortSignal.any([ctx.requestSignal, timeout]) : timeout;
  const service = await acquirePhone(ctx, signal);
  try { return await raceWithAbort(work(service, signal), signal); }
  finally { service[Symbol.dispose]?.(); }
}
