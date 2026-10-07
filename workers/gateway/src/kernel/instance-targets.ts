import { cancelBinaryBody } from "@humansandmachines/gsv/protocol";
import type { InstallationInstances } from "@humansandmachines/gsv/services/instances";
import { acquireInstances, instanceActor, withInstances } from "./instance-service";
import type { KernelContext } from "./context";
import { principalOf } from "./context";
import type { TargetDescriptor, TargetDiscovery, TargetListOptions } from "./targets";
import type { RequestFrame, ResponseFrame } from "../protocol/frames";
import { raceWithAbort } from "../shared/abort";
import { withByteStreamFinalizer } from "../shared/streams";
import { rejectBeforeDispatch } from "./request-rejection";

export type InstanceTargetRoute = { kind: "instance"; instanceId: string };

export async function discoverInstanceTargets(ctx: KernelContext, options: TargetListOptions): Promise<TargetDiscovery> {
  const principal = principalOf(ctx);
  if (!ctx.env.INSTANCES || principal?.kind !== "human") return { targets: [], complete: true };
  const startedAt = Date.now();
  return withInstances(ctx, async (service, actor) => {
    const inventory = await service.list(actor, { includeTerminal: options.includeOffline });
    const targets: TargetDescriptor[] = inventory.instances.filter(value => options.includeOffline || value.state === "ready").map(value => ({
      targetId: value.targetId, ownerUid: value.ownerUid, ownerUsername: ctx.auth.getPasswdByUid(value.ownerUid)?.username ?? null,
      label: value.label, description: `Cloud browser; ${value.state}; expires ${new Date(value.expiresAt).toISOString()}`,
      platform: "browser", version: value.templateRevision,
      online: value.state === "ready" && value.expiresAt > Date.now(),
      implements: value.implements,
      firstSeenAt: value.createdAt, lastSeenAt: value.stoppedAt ?? value.readyAt ?? value.createdAt,
      connectedAt: value.readyAt ?? null, disconnectedAt: value.stoppedAt ?? null,
      route: { kind: "instance", instanceId: value.instanceId },
      instance: { instanceId: value.instanceId, state: value.state, expiresAt: value.expiresAt, profileId: value.profileId },
    }));
    return { targets, complete: true };
  }, 2000).catch(error => {
    // Discovery is optional, but its failure must remain inspectable by the owner.
    const requestId = `instance-discovery:${crypto.randomUUID()}`;
    ctx.ledger?.append({
      requestId, timestamp: startedAt, principalKind: principal.kind,
      uid: principal.account.uid, ownerUid: instanceActor(ctx).ownerUid,
      pid: ctx.processId ?? null, runId: ctx.processRunId ?? null,
      target: "gsv", call: "sys.instance.list", args: JSON.stringify({ includeTerminal: options.includeOffline ?? false }),
      purpose: "Discover cloud instances",
    });
    ctx.ledger?.complete(requestId, {
      outcome: ctx.requestSignal?.aborted ? "cancelled" : "failed",
      error: error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error),
    });
    return { targets: [], complete: false };
  });
}

export async function requestInstanceTarget(frame: RequestFrame, target: TargetDescriptor, deadlineAt: number, ctx: KernelContext): Promise<ResponseFrame> {
  let transferred = false;
  let dispatched = false;
  let service: InstallationInstances | undefined;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error("Browser target request timed out")), Math.max(0, deadlineAt - Date.now()));
  const signal = ctx.requestSignal ? AbortSignal.any([ctx.requestSignal, deadline.signal]) : deadline.signal;
  try {
    if (!ctx.env.INSTANCES || target.route.kind !== "instance") throw new Error("Instance target is unavailable");
    const actor = instanceActor(ctx), id = target.route.instanceId;
    const acquired = await acquireInstances(ctx, signal);
    service = acquired;
    signal.throwIfAborted();
    dispatched = true;
    const invocation = acquired.execute(actor, id, frame, deadlineAt);
    const response = await raceWithAbort(invocation, signal, { onAbort: () => {
      transferred = true;
      ctx.defer(Promise.allSettled([
        acquired.cancel(actor, id, frame.id),
        invocation.then(async late => { if (late.ok) await cancelBinaryBody(late.body, "Browser response arrived after cancellation"); }),
      ]).finally(() => acquired[Symbol.dispose]?.()));
    } });
    if (response.id !== frame.id) { if (response.ok) await cancelBinaryBody(response.body, "Invalid browser response"); throw new Error("Browser response identity mismatch"); }
    if (response.ok && response.body) {
      transferred = true;
      return { ...response, body: { ...response.body, stream: withByteStreamFinalizer(response.body.stream, () => acquired[Symbol.dispose]?.()) } };
    }
    return response;
  } catch (error) {
    if (dispatched) throw error;
    await cancelBinaryBody(frame.body, "Browser request was not dispatched");
    return rejectBeforeDispatch(frame, ctx.requestSignal?.aborted ? 499 : deadline.signal.aborted ? 504 : 503,
      error instanceof Error ? error.message : String(error));
  } finally { clearTimeout(timer); if (!transferred) service?.[Symbol.dispose]?.(); }
}
