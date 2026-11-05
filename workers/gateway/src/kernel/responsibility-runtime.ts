import { z } from "zod";
import { MANAGED_LIFECYCLE_RECHECK_MS } from "../installation/lifecycle";
import type { KernelContext } from "./context";
import type { Kernel } from "./do";
import { shipConsumer } from "./events/consumers";
import type { EventDefinition } from "./events/registry";
import type { LoggedEvent } from "./events/store";

const READY = "responsibility.ready";

const readyBodySchema = z.strictObject({
  responsibilityIds: z.array(z.string()).min(1).max(100),
  ledgerRevision: z.number().int().nonnegative(),
});

/** The ledger a wake batch is about: one per owner. */
function ledgerSubject(ownerUid: number): string {
  return `owner:${ownerUid}`;
}

/**
 * The records a batch names that still need a run. One settled after the batch was taken
 * needs none: if Ship settled it, Ship knows, and anyone else's change goes in the next batch.
 */
function unsettled(event: LoggedEvent, ctx: KernelContext) {
  const { responsibilityIds, ledgerRevision } = readyBodySchema.parse(event.body);
  const ids = responsibilityIds.filter((id) => {
    const record = ctx.responsibilities.get(event.ownerUid, id);
    if (!record) return false;
    return !((record.state === "resolved" || record.state === "cancelled") && record.revision > ledgerRevision);
  });
  return { ids, ledgerRevision };
}

/** Responsibilities that need Ship's attention, taken by the wake timer. */
export const responsibilityReadyEvent: EventDefinition = {
  // Unlaned, so a stuck contact message or notice never holds the ledger's wakes; one waits at a time.
  routes: (event) => [{ consumer: shipConsumer(event.ownerUid), lane: null }],
  // Checked before Ship is found, so a batch with nothing left starts no Ship.
  withdrawal: (event, ctx) => unsettled(event, ctx).ids.length === 0 ? "its work was settled while it waited" : null,
  // A batch goes by its delivery's id, which a batch an older Kernel had on its way keeps.
  admit(event, _prepared, ctx, batchId) {
    const { ids, ledgerRevision } = unsettled(event, ctx);
    return {
      event: {
        kind: "responsibility.ready", severity: "info", audience: "model",
        payload: {
          batchId,
          ledgerRevision,
          responsibilityIds: ids,
          receivedAtMs: Date.now(),
        },
      },
      admission: { idle: "start", busy: "join" },
      responsibilities: { ledgerRevision, ids },
    };
  },
  // Work that came due while the batch waited goes in the next one.
  settled: (event, ctx) => ctx.reconcileResponsibilityWake(event.ownerUid),
};

/** The owner's wake timer: when ledger work comes due, it appends one batch for Ship. */
export class ResponsibilityRuntime {
  constructor(readonly host: Kernel) {}

  async recoverResponsibilityWakes(): Promise<void> {
    for (const ownerUid of this.host.responsibilities.ownersWithLedgers()) {
      await this.reconcileResponsibilityWake(ownerUid);
    }
  }

  async reconcileResponsibilityWake(ownerUid: number): Promise<void> {
    const now = Date.now();
    const state = this.host.responsibilities.wakeState(ownerUid);
    // A batch still on its way holds the next one; its delivery reconciles again.
    const nextWakeAt = this.host.auth.isAccountDisabled(ownerUid) || this.batchWaiting(ownerUid)
      ? null
      : this.host.responsibilities.nextWakeAt(ownerUid, now);
    if (nextWakeAt === null) {
      this.host.responsibilities.setWakeTask(
        ownerUid,
        state.generation,
        null,
        null,
        now,
      );
      if (state.taskId) await this.host.cancelSchedule(state.taskId);
      return;
    }
    await this.scheduleResponsibilityWakeAt(
      ownerUid,
      state.generation,
      nextWakeAt,
      state.taskId,
    );
  }

  async scheduleResponsibilityWakeAt(
    ownerUid: number,
    generation: number,
    wakeAtMs: number,
    previousTaskId: string | null,
  ): Promise<void> {
    const wakeAt = new Date(
      Math.ceil(Math.max(Date.now() + 1_000, wakeAtMs) / 1_000) * 1_000,
    );
    const task = await this.host.schedule(
      wakeAt,
      "onResponsibilityWake",
      { ownerUid, generation },
    );
    const installed = this.host.responsibilities.setWakeTask(
      ownerUid,
      generation,
      task.id,
      wakeAt.getTime(),
      Date.now(),
    );
    if (!installed) {
      await this.host.cancelSchedule(task.id);
      return;
    }
    if (previousTaskId && previousTaskId !== task.id) {
      await this.host.cancelSchedule(previousTaskId);
    }
  }

  /** Takes the work that needs Ship's attention as one event, which the event log delivers. */
  async onResponsibilityWake(
    payload: { ownerUid: number; generation: number },
    task?: { id?: string },
  ): Promise<void> {
    const state = this.host.responsibilities.wakeState(payload.ownerUid);
    if (state.generation !== payload.generation) {
      await this.reconcileResponsibilityWake(payload.ownerUid);
      return;
    }
    if (task?.id && state.taskId !== task.id) return;

    // A removed account takes no new batch; one already on its way still goes.
    if (!this.host.auth.isAccountDisabled(payload.ownerUid) && !this.batchWaiting(payload.ownerUid)) {
      const gate = await this.host.onboarding.managedWorkGate();
      if (!gate.allowed) {
        // A restricted space takes nothing from its ledger; the timer looks again shortly.
        await this.scheduleResponsibilityWakeAt(
          payload.ownerUid, payload.generation, Date.now() + MANAGED_LIFECYCLE_RECHECK_MS, state.taskId,
        );
        return;
      }
      const appended = this.host.ctx.storage.transactionSync(() => {
        if (this.batchWaiting(payload.ownerUid)) return false;
        const batch = this.host.responsibilities.takeReadyBatch(payload.ownerUid, Date.now());
        if (!batch) return false;
        this.host.eventRuntime.append({
          type: READY,
          ownerUid: payload.ownerUid,
          subject: ledgerSubject(payload.ownerUid),
          actor: { kind: "kernel" },
          key: crypto.randomUUID(),
          body: { responsibilityIds: batch.ids, ledgerRevision: batch.throughRevision },
        });
        return true;
      });
      if (appended) await this.host.eventRuntime.kick();
    }
    await this.reconcileResponsibilityWake(payload.ownerUid);
  }

  private batchWaiting(ownerUid: number): boolean {
    return this.host.eventRuntime.pending(READY, ledgerSubject(ownerUid)).length > 0;
  }
}
