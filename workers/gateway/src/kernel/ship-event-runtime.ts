import type { DurableTaskOptions } from "../shared/durable-tasks";
import { sendFrameToProcess } from "../shared/utils";
import { MANAGED_LIFECYCLE_RECHECK_MS } from "../installation/lifecycle";
import { ensurePersonalController } from "./personal-controller";
import type { QueuedShipEvent } from "./ship-event-store";
import type { Kernel } from "./do";

const MAX_RETRY_DELAY_MS = 5 * 60_000;

/** Delivers each owner's Ship events in order to its current Ship, retrying until admitted. */
export class ShipEventRuntime {
  constructor(readonly host: Kernel) {}

  queue(ownerUid: number): void {
    this.host.ctx.waitUntil(this.schedule(ownerUid, Date.now()));
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
  }

  private async deliverQueued(ownerUid: number, task: { id: string }): Promise<void> {
    for (let queued = this.host.shipEvents.next(ownerUid); queued; queued = this.host.shipEvents.next(ownerUid)) {
      if (queued.nextAttemptAtMs > Date.now()) {
        await this.schedule(ownerUid, queued.nextAttemptAtMs, task.id);
        return;
      }
      try {
        await this.deliver(queued);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const retryAt = Date.now() + Math.min(MAX_RETRY_DELAY_MS, 1_000 * (2 ** Math.min(8, queued.attemptCount + 1)));
        this.host.shipEvents.failed(queued.eventId, message, retryAt, Date.now());
        console.warn(`[Kernel] Failed to deliver Ship event ${queued.eventId}:`, message);
        await this.schedule(ownerUid, retryAt, task.id);
        return;
      }
    }
  }

  private async deliver(queued: QueuedShipEvent): Promise<void> {
    const processId = await ensurePersonalController(
      queued.ownerUid,
      this.host.buildKernelContext({ callerOwnerUid: queued.ownerUid }),
    );
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
