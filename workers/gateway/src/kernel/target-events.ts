import {
  procHistoryTargetEventRegistry, type ProcHistoryEventPayload,
} from "@humansandmachines/gsv/protocol";
import {
  processEventDeliverResultSchema, type InternalRequestFrame, type InternalResponseFrame,
} from "../protocol/process-frames";
import { sendFrameToProcess } from "../shared/utils";
import type { Kernel } from "./do";
import { getVisibleTarget } from "./targets";
import { peerAllowsCall } from "./peer";
import type { SignalWatchRecord } from "./signal-watches";

/** Kernel lifecycle facts are the only producer; claimed machine frames never enter this path. */
export async function deliverTargetConnectionEvent(
  kernel: Kernel,
  payload: ProcHistoryEventPayload<"target.connection">,
  transitionId: string,
  watches: readonly SignalWatchRecord[],
): Promise<void> {
  const definition = procHistoryTargetEventRegistry["target.status"];
  for (const watch of watches) {
    const gate = await kernel.onboarding.managedWorkGate();
    if (!gate.allowed) return;
    if (!kernel.signalWatches.isActiveRevision(watch.watchId, watch.revision)) continue;
    try {
      const process = kernel.procs.get(watch.targetProcessId);
      const ctx = kernel.buildProcessContext(watch.targetProcessId);
      if (!process || process.ownerUid !== watch.uid || !ctx?.peer ||
          !peerAllowsCall(ctx.peer, "signal.watch") ||
          !getVisibleTarget(ctx, payload.targetId, { includeOffline: true })) {
        throw new Error("Target watch authorization no longer permits delivery");
      }
      const audience = watch.audience ?? definition.defaultAudience;
      if (!definition.allowedAudiences.includes(audience)) throw new Error("Unsupported target event audience");
      const eventId = `${transitionId}:${watch.watchId}`;
      const request: InternalRequestFrame<"proc.event.deliver"> = {
        type: "req", id: crypto.randomUUID(), call: "proc.event.deliver",
        args: {
          eventId,
          event: { kind: definition.kind, payload, severity: definition.severity, audience },
        },
      };
      let response: InternalResponseFrame<"proc.event.deliver"> | null;
      try {
        response = await sendFrameToProcess(kernel.installationId, watch.targetProcessId, request);
      } catch {
        // A transport failure skips this transition without retiring the subscription.
        continue;
      }
      if (response?.type === "res" && !response.ok && (
        response.error.code === 409 || (response.error.code >= 500 && response.error.code < 600)
      )) {
        continue;
      }
      if (!response || response.type !== "res" || !response.ok) {
        throw new Error("Target event delivery was not acknowledged");
      }
      const result = processEventDeliverResultSchema.safeParse(response.data);
      if (!result.success || result.data.eventId !== eventId) {
        throw new Error("Target event acknowledgment did not match the delivery");
      }
      if (result.data.ignored) continue;
      if (watch.once) kernel.signalWatches.deleteHandled(watch.watchId, watch.revision);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      kernel.signalWatches.markFailed(watch.watchId, message, watch.revision);
    }
  }
}
