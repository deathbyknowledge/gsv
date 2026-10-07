import { bodyFromBytes, bodyToBytes, bodyToText, cancelBinaryBody } from "@humansandmachines/gsv/protocol";
import type { BrowserHandoff, BrowserHumanInput, JsonObject } from "@humansandmachines/gsv/protocol";
import { principalOf, type KernelContext } from "../context";
import { hasCapability } from "../capabilities";
import type { RequestFrame, ResponseFrame } from "../../protocol/frames";
import { authorizeNestedOperation } from "../tool-approval";
import { acquireInstances, instanceActor, withInstances } from "../instance-service";
import { handleResponsibilityGet, handleResponsibilityUpdate, requireWritableResponsibility } from "../responsibilities";
import { raceWithAbort } from "../../shared/abort";
import { withByteStreamFinalizer } from "../../shared/streams";

export type InstanceRequest = Extract<RequestFrame, { call: `sys.instance.${string}` | `sys.browser.${string}` }>;

export async function handleInstanceRequest(frame: InstanceRequest, ctx: KernelContext): Promise<ResponseFrame> {
  try {
    if (frame.call !== "sys.browser.input") await cancelBinaryBody(frame.body, "This browser action has no request body");
    return await dispatchInstanceRequest(frame, ctx);
  } finally { await cancelBinaryBody(frame.body, "Browser request completed"); }
}

async function dispatchInstanceRequest(frame: InstanceRequest, ctx: KernelContext): Promise<ResponseFrame> {
  const actor = instanceActor(ctx);
  if (["sys.browser.handoff.open", "sys.browser.handoff.finish", "sys.browser.frame", "sys.browser.watch", "sys.browser.input"].includes(frame.call) && !actor.human) {
    throw new Error("This browser action requires the signed-in human owner");
  }
  if (!hasCapability(principalOf(ctx)?.calls ?? [], frame.call)) {
    throw new Error(`EACCES: permission denied: ${frame.call}`);
  }
  if (frame.call === "sys.browser.watch") {
    const timeout = AbortSignal.timeout(30000);
    const signal = ctx.requestSignal ? AbortSignal.any([ctx.requestSignal, timeout]) : timeout;
    const service = await acquireInstances(ctx, signal);
    let transferred = false;
    try {
      signal.throwIfAborted();
      const invocation = service.watch(actor, frame.args);
      const result = await raceWithAbort(invocation, signal, { onAbort: () => {
        transferred = true;
        ctx.defer(Promise.allSettled([invocation.then(late => cancelBinaryBody(late.body, "Browser view cancelled before admission"))])
          .finally(() => service[Symbol.dispose]?.()));
      } });
      transferred = true;
      return { type: "res", id: frame.id, ok: true, data: result.data,
        body: { ...result.body, stream: withByteStreamFinalizer(result.body.stream, () => service[Symbol.dispose]?.()) } };
    } finally { if (!transferred) service[Symbol.dispose]?.(); }
  }
  if (["sys.instance.start", "sys.instance.stop", "sys.browser.profile.create", "sys.browser.profile.delete", "sys.browser.profile.save", "sys.browser.handoff.request", "sys.browser.handoff.cancel"].includes(frame.call)) {
    // SAFETY: The protocol validator has admitted these JSON-only syscall arguments.
    await authorizeNestedOperation(ctx, frame.call, frame.args as JsonObject);
    ctx.requestSignal?.throwIfAborted();
  }
  return withInstances(ctx, async (service, owner, signal) => {
    let data: Extract<ResponseFrame, { ok: true }>["data"];
    switch (frame.call) {
      case "sys.instance.catalog": data = await service.catalog(owner); break;
      case "sys.instance.start": data = await service.start(owner, frame.args); break;
      case "sys.instance.list": data = await service.list(owner, frame.args); break;
      case "sys.instance.get": data = await service.get(owner, frame.args); break;
      case "sys.instance.stop": data = await service.stop(owner, frame.args); break;
      case "sys.browser.profile.create": data = await service.createProfile(owner, frame.args); break;
      case "sys.browser.profile.list": data = await service.listProfiles(owner, frame.args); break;
      case "sys.browser.profile.save": data = await service.saveProfile(owner, frame.args.instanceId); break;
      case "sys.browser.profile.get": data = await service.getProfile(owner, frame.args.profileId); break;
      case "sys.browser.profile.delete": data = await service.deleteProfile(owner, frame.args.profileId); break;
      case "sys.browser.handoff.request": {
        if (ctx.processId && !frame.args.responsibilityId) throw new Error("Agent browser handoffs require the responsibilityId of the waiting work");
        const work = frame.args.responsibilityId ? requireWritableResponsibility(frame.args.responsibilityId, ctx) : undefined;
        const result = await service.requestHandoff(owner, work ? { ...frame.args, responsibilityId: work.id } : frame.args);
        if (result.handoff.responsibilityId) {
          const selector = { instanceId: result.handoff.instanceId, requestId: result.handoff.requestId };
          if (result.handoff.state === "pending" || result.handoff.state === "active") {
            try {
              await ctx.trackBrowserHandoff(owner.ownerUid, result.handoff);
              ctx.requestSignal?.throwIfAborted();
              const current = requireWritableResponsibility(result.handoff.responsibilityId, ctx);
              if (current.state === "resolved" || current.state === "cancelled") {
                result.handoff = (await service.cancelHandoff(owner, selector)).handoff!;
              } else {
                await handleResponsibilityUpdate({ id: current.id, expectedRevision: current.revision, patch: {
                  state: "waiting", blocker: `browser handoff ${selector.instanceId}/${selector.requestId}`,
                  nextCheckAtMs: result.handoff.expiresAt,
                  details: { ...current.details, browserHandoff: selector },
                } }, ctx);
                // Completion may have raced the waiting update. Read the provider again after installing it.
                result.handoff = (await service.getHandoff(owner, selector)).handoff!;
              }
            } catch (error) {
              await service.cancelHandoff(owner, selector);
              throw error;
            }
          }
          await completeResponsibility(result.handoff, ctx);
        }
        data = { ...result, actionPath: ctx.installationIdentity?.canonicalOrigin ? new URL(result.actionPath, ctx.installationIdentity.canonicalOrigin).href : result.actionPath }; break;
      }
      case "sys.browser.handoff.get": data = await service.getHandoff(owner, frame.args); break;
      case "sys.browser.handoff.open": data = await service.openHandoff(owner, frame.args); break;
      case "sys.browser.handoff.cancel": {
        const result = await service.cancelHandoff(owner, frame.args);
        await completeResponsibility(result.handoff, ctx); data = result; break;
      }
      case "sys.browser.handoff.finish": {
        const result = await service.finishHandoff(owner, frame.args);
        await completeResponsibility(result.handoff, ctx); data = result; break;
      }
      case "sys.browser.frame": {
        const result = await service.frame(owner, frame.args);
        // Materialize this bounded image before releasing its remote RPC capability.
        const bytes = await bodyToBytes(result.body, 4 * 1024 * 1024, signal);
        return { type: "res", id: frame.id, ok: true, data: result.data, body: bodyFromBytes(bytes) };
      }
      case "sys.browser.input": {
        if (!frame.body) throw new Error("Browser input requires a body");
        const text = await bodyToText(frame.body, 128 * 1024, signal);
        // The owning instance service validates this private, bounded input body.
        // SAFETY: This assertion only transports the value to that validation boundary; Kernel does not interpret it.
        const input = JSON.parse(text) as BrowserHumanInput;
        data = await service.input(owner, frame.args, input);
        break;
      }
    }
    return { type: "res", id: frame.id, ok: true, data };
  }, 60000);
}

async function completeResponsibility(handoff: BrowserHandoff | null, ctx: KernelContext): Promise<void> {
  if (!handoff?.responsibilityId || handoff.state === "active" || handoff.state === "pending") return;
  const { responsibility } = handleResponsibilityGet({ id: handoff.responsibilityId }, ctx);
  if (responsibility.state !== "waiting" || responsibility.blocker !== `browser handoff ${handoff.instanceId}/${handoff.requestId}`) return;
  await handleResponsibilityUpdate({ id: responsibility.id, expectedRevision: responsibility.revision, patch: {
    state: "open", blocker: null, nextCheckAtMs: Date.now(),
  } }, ctx);
}
