import { errorMessageFromUnknown } from "../inference/errors";
import { pendingRunFinishesSchema, type RunFinishPayload } from "./run/finish";
import type { Process } from "./do";

const MAX_RUN_FINISH_DELIVERY_ATTEMPTS = 10;
const PENDING_RUN_FINISHES_KEY = "pendingRunFinishes";

/** Owns durable run-finish receipts and their retry/terminalization policy. */
export class ProcessFinishDeliveryService {
  constructor(private readonly host: Process) {}

  pending(): RunFinishPayload[] {
    return pendingRunFinishesSchema.parse(
      JSON.parse(this.host.store.state.getValue(PENDING_RUN_FINISHES_KEY) ?? "[]"),
    );
  }

  record(payload: RunFinishPayload): boolean {
    const pending = this.pending();
    if (pending.some((finish) => finish.runId === payload.runId)) return false;
    pending.push(payload);
    this.host.store.state.setValue(PENDING_RUN_FINISHES_KEY, JSON.stringify(pending));
    return true;
  }

  async deliver(runId: string): Promise<void> {
    if (this.host.killed) return;
    const pending = this.pending();
    const payload = pending.find((finish) => finish.runId === runId);
    if (!payload) return;

    try {
      const { deliveryAttempts: _deliveryAttempts, ...signalPayload } = payload;
      await this.host.sendSignal("proc.run.finished", signalPayload);
    } catch (error) {
      if (this.host.killed) return;
      console.warn(`[Process] Failed to emit finish for ${runId}:`, error);
      const attempts = (payload.deliveryAttempts ?? 0) + 1;
      if (attempts >= MAX_RUN_FINISH_DELIVERY_ATTEMPTS) {
        this.remove(runId);
        const messageId = this.host.store.messages.appendMessage(
          "system",
          "Run completion signaling stopped after repeated transport failures. The completed activity remains in this process history.",
          { runId },
        );
        void this.host.signals.changed(["messages"], { runId, messageId }).catch((cause) => {
          console.warn(
            `[Process] Failed to announce terminal finish-delivery failure for ${runId}: ${errorMessageFromUnknown(cause)}`,
          );
        });
        return;
      }
      payload.deliveryAttempts = attempts;
      this.host.store.state.setValue(PENDING_RUN_FINISHES_KEY, JSON.stringify(pending));
      await this.host.run.schedule(5, "onRunFinishDelivery", runId, {
        idempotent: false,
        retry: { maxAttempts: 10, baseDelayMs: 1_000, maxDelayMs: 30_000 },
      });
      return;
    }

    if (!this.host.killed) this.remove(runId);
  }

  private remove(runId: string): void {
    const remaining = this.pending().filter((finish) => finish.runId !== runId);
    if (remaining.length > 0) {
      this.host.store.state.setValue(PENDING_RUN_FINISHES_KEY, JSON.stringify(remaining));
    } else {
      this.host.store.state.deleteValue(PENDING_RUN_FINISHES_KEY);
    }
  }
}
