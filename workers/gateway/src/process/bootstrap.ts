import { errorMessageFromUnknown } from "../inference/errors";
import type { Process } from "./do";

/** Reconciles durable work that may have been interrupted by object eviction. */
export async function recoverProcess(host: Process): Promise<void> {
  if (host.killed) return;

  const recoveredRun = host.runs.active;
  if (
    recoveredRun?.pendingMediaMessageId !== undefined &&
    host.store.messages.hasMessageMedia(recoveredRun.pendingMediaMessageId, recoveredRun.runId)
  ) {
    delete recoveredRun.pendingMediaMessageId;
    host.runs.active = recoveredRun;
  }

  if (
    recoveredRun &&
    !host.store.tools.getPendingHilForRun(recoveredRun.runId) &&
    recoveredRun.pendingMediaMessageId === undefined
  ) {
    try {
      await host.run.scheduleTick(recoveredRun.runId);
    } catch (error) {
      if (!host.handleRunStopped(recoveredRun.runId)) {
        await host.run.finishRun(recoveredRun.runId, {
          reason: "recovery.schedule.error",
          status: "error",
          resultText: null,
          error: `Failed to recover process run: ${errorMessageFromUnknown(error)}`,
        });
      }
    }
  }

  for (const finish of host.finishDelivery.pending()) {
    host.startBackground(
      `finish delivery for ${finish.runId}`,
      host.finishDelivery.deliver(finish.runId),
    );
  }
}
