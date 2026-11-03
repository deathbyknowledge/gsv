import {
  procHistoryTargetEventRegistry, type ProcHistoryEventPayload,
} from "@humansandmachines/gsv/protocol";
import { deliverEventToProcess } from "../shared/utils";
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
          kernel.auth.isAccountDisabled(watch.uid) || kernel.auth.isAccountDisabled(process.uid) ||
          !peerAllowsCall(ctx.peer, "signal.watch") ||
          !getVisibleTarget(ctx, payload.targetId, { includeOffline: true })) {
        throw new Error("Target watch authorization no longer permits delivery");
      }
      const audience = watch.audience ?? definition.defaultAudience;
      if (!definition.allowedAudiences.includes(audience)) throw new Error("Unsupported target event audience");
      const eventId = `${transitionId}:${watch.watchId}`;
      let result: Awaited<ReturnType<typeof deliverEventToProcess>>;
      try {
        result = await deliverEventToProcess(kernel.installationId, watch.targetProcessId, {
          eventId,
          event: { kind: definition.kind, payload, severity: definition.severity, audience },
        });
      } catch {
        // A transport or Process failure skips this transition without retiring the subscription.
        continue;
      }
      if ("unavailable" in result) {
        if (result.unavailable === "transitioning") continue;
        throw new Error("Target event delivery was not acknowledged");
      }
      if (result.ignored) continue;
      if (watch.once) kernel.signalWatches.deleteHandled(watch.watchId, watch.revision);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      kernel.signalWatches.markFailed(watch.watchId, message, watch.revision);
    }
  }
}
