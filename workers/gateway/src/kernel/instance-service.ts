import type { InstallationInstances, InstanceActor } from "@humansandmachines/gsv/services/instances";
import { principalOf, resolveCallerOwnerUid, type KernelContext } from "./context";
import { raceWithAbort } from "../shared/abort";
import type { ResponsibilityRecord } from "@humansandmachines/gsv/protocol";
import { z } from "zod";

const handoffLinkSchema = z.object({ instanceId: z.string(), requestId: z.string() });

/** Work owns its linked human-control request; release it before committing terminal work. */
export function cancelResponsibilityHandoff(work: ResponsibilityRecord, ctx: KernelContext): Promise<void> | undefined {
  const link = handoffLinkSchema.safeParse(work.details?.browserHandoff);
  if (!link.success) return;
  return withInstances(ctx, async (service, actor) => {
    const { handoff } = await service.getHandoff(actor, link.data);
    // Details are editable. Only the provider's matching responsibility grants cleanup authority.
    if (handoff?.responsibilityId !== work.id || !["pending", "active"].includes(handoff.state)) return;
    await service.cancelHandoff(actor, link.data);
  });
}

export function instanceActor(ctx: KernelContext): InstanceActor {
  const principal = principalOf(ctx);
  if (principal?.kind !== "human" || !principal.account) throw new Error("Instances require a human owner");
  const actor: InstanceActor = { ownerUid: resolveCallerOwnerUid(ctx), human: !ctx.processId && !ctx.toolOwner };
  if (ctx.processId) actor.processId = ctx.processId;
  return actor;
}

export async function acquireInstances(ctx: KernelContext, signal?: AbortSignal): Promise<InstallationInstances> {
  if (!ctx.env.INSTANCES) throw new Error("Cloud instances are not configured for this space");
  return raceWithAbort(ctx.env.INSTANCES.getInstallation(ctx.installationId), signal, {
    onLateResolve: service => service[Symbol.dispose]?.(),
  });
}

export async function withInstances<T>(ctx: KernelContext, work: (service: InstallationInstances, actor: InstanceActor) => Promise<T>, timeoutMs = 30000): Promise<T> {
  const actor = instanceActor(ctx);
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = ctx.requestSignal ? AbortSignal.any([ctx.requestSignal, timeout]) : timeout;
  const service = await acquireInstances(ctx, signal);
  try { return await raceWithAbort(work(service, actor), signal); }
  finally { service[Symbol.dispose]?.(); }
}
