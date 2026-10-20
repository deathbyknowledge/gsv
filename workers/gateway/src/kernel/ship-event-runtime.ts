import type { DurableTaskOptions } from "../shared/durable-tasks";
import { sendFrameToProcess } from "../shared/utils";
import { MANAGED_LIFECYCLE_RECHECK_MS } from "../installation/lifecycle";
import { admitQueuedContactEvent } from "./federation/attention";
import { ensurePersonalController } from "./personal-controller";
import type { QueuedShipEvent } from "./ship-event-store";
import type { Kernel } from "./do";

const MAX_RETRY_DELAY_MS = 5 * 60_000;

/** Delivers each owner's Ship events in order to its current Ship, retrying until admitted. */
export class ShipEventRuntime {
  constructor(readonly host: Kernel) {}

  queue(ownerUid: number): Promise<void> {
    return this.schedule(ownerUid, Date.now());
  }

  async recover(): Promise<void> {
    for (const ownerUid of this.host.shipEvents.ownersWithEvents()) {
      const next = this.host.shipEvents.next(ownerUid);
      if (next) await this.schedule(ownerUid, next.nextAttemptAtMs);
    }
  }

  async onShipEvents(ownerUid: number, task: { id: string }): Promise<void> {
    if (this.host.auth.isAccountDisabled(ownerUid)) return;
    const gate = await this.host.onboarding.managedWorkGate();
    if (!gate.allowed) {
      await this.schedule(ownerUid, Date.now() + MANAGED_LIFECYCLE_RECHECK_MS, task.id);
      return;
    }
    try {
      await this.deliverQueued(ownerUid, task);
    } finally {
      // Delivery stamps recovery on the ledger; arm its wake even when this pass
      // finds the queue already drained, so a failed reconcile is retried.
      await this.host.responsibilityRuntime.reconcileResponsibilityWake(ownerUid);
    }
    // An event queued while this pass awaited joined this running task, which ends now.
    const late = this.host.shipEvents.next(ownerUid);
    if (late && !this.host.auth.isAccountDisabled(ownerUid)) await this.schedule(ownerUid, late.nextAttemptAtMs, task.id);
  }

  private async deliverQueued(ownerUid: number, task: { id: string }): Promise<void> {
    for (let queued = this.host.shipEvents.next(ownerUid); queued; queued = this.host.shipEvents.next(ownerUid)) {
      const admitted = this.admit(queued);
      if (admitted === "stop") return;
      if (admitted === "revoked") {
        this.host.shipEvents.delivered(queued.eventId);
        continue;
      }
      if (admitted.nextAttemptAtMs > Date.now()) {
        await this.schedule(ownerUid, admitted.nextAttemptAtMs, task.id);
        return;
      }
      try {
        await this.deliver(admitted);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const retryAt = Date.now() + Math.min(MAX_RETRY_DELAY_MS, 1_000 * (2 ** Math.min(8, admitted.attemptCount + 1)));
        this.host.shipEvents.failed(admitted.eventId, message, retryAt, Date.now());
        console.warn(`[Kernel] Failed to deliver Ship event ${admitted.eventId}:`, message);
        await this.schedule(ownerUid, retryAt, task.id);
        return;
      }
    }
  }

  /** Checked again after every await: removal stops delivery, and the event's producer rebinds or revokes it. */
  private admit(queued: QueuedShipEvent): QueuedShipEvent | "revoked" | "stop" {
    if (this.host.auth.isAccountDisabled(queued.ownerUid)) return "stop";
    const ctx = this.host.buildKernelContext({ callerOwnerUid: queued.ownerUid });
    const event = admitQueuedContactEvent(queued.ownerUid, queued.eventId, queued.event, ctx);
    return event ? { ...queued, event } : "revoked";
  }

  /** Delivers one event; the Process frame is sent synchronously after the last admission check. */
  private async deliver(admitted: QueuedShipEvent): Promise<void> {
    const processId = await ensurePersonalController(
      admitted.ownerUid,
      this.host.buildKernelContext({ callerOwnerUid: admitted.ownerUid }),
    );
    const queued = this.admit(admitted);
    if (queued === "revoked") this.host.shipEvents.delivered(admitted.eventId);
    if (queued === "revoked" || queued === "stop") return;
    const response = await sendFrameToProcess(this.host.installationId, processId, {
      type: "req",
      id: crypto.randomUUID(),
      call: "proc.runtime.event.deliver",
      args: { eventId: queued.eventId, event: queued.event },
    });
    if (!response) throw new Error("Ship event produced no Process response");
    if (!response.ok) throw new Error(response.error.message);
    const now = Date.now();
    this.host.ctx.storage.transactionSync(() => {
      this.host.shipEvents.delivered(queued.eventId);
      this.host.responsibilities.markEventDelivered(queued.ownerUid, [queued.event.responsibilityId], now);
    });
  }

  private async schedule(ownerUid: number, at: number, excludeTaskId?: string): Promise<void> {
    const options: DurableTaskOptions = { idempotent: true };
    if (excludeTaskId) options.excludeTaskId = excludeTaskId;
    await this.host.schedule(new Date(Math.max(Date.now(), at)), "onShipEvents", ownerUid, options);
  }
}
