import {
  sendFrameToProcess,
} from "../shared/utils";
import type {
  InternalRequestFrame,
} from "../protocol/process-frames";
import {
  ensurePersonalController,
} from "./personal-controller";
import {
  type ResponsibilityWakeBatch,
} from "./responsibility-store";
import {
  MANAGED_LIFECYCLE_RECHECK_MS,
} from "../installation/lifecycle";
import type { Kernel } from "./do";

function responsibilityRuntimeEventFrame(
  batch: ResponsibilityWakeBatch,
): InternalRequestFrame<"proc.runtime.event.deliver"> {
  return {
    type: "req",
    id: crypto.randomUUID(),
    call: "proc.runtime.event.deliver",
    args: {
      eventId: batch.eventId,
      event: {
        type: "r12y.ready",
        batchId: batch.id,
        ledgerRevision: batch.throughRevision,
        responsibilityIds: batch.responsibilities.map(({ id }) => id),
      },
    },
  };
}



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
    const nextWakeAt = this.host.responsibilities.nextWakeAt(ownerUid, now);
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

    const gate = await this.host.onboarding.managedWorkGate();
    if (!gate.allowed) {
      await this.scheduleResponsibilityWakeAt(
        payload.ownerUid,
        payload.generation,
        Date.now() + MANAGED_LIFECYCLE_RECHECK_MS,
        state.taskId,
      );
      return;
    }

    const batch = this.host.responsibilities.createReadyBatch(payload.ownerUid, Date.now());
    if (!batch) {
      await this.reconcileResponsibilityWake(payload.ownerUid);
      return;
    }

    try {
      const processId = await ensurePersonalController(
        payload.ownerUid,
        this.host.buildKernelContext({ callerOwnerUid: payload.ownerUid }),
      );
      const response = await sendFrameToProcess(
        this.host.installationId,
        processId,
        responsibilityRuntimeEventFrame(batch),
      );
      if (!response) throw new Error("Responsibility event produced no Process response");
      if (!response.ok) throw new Error(response.error.message);
      this.host.responsibilities.markBatchDelivered(batch.id);
      await this.reconcileResponsibilityWake(payload.ownerUid);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.host.responsibilities.markBatchFailed(batch.id, message, Date.now());
      const current = this.host.responsibilities.pendingBatch(payload.ownerUid);
      const attempt = current?.attemptCount ?? batch.attemptCount + 1;
      const retryAt = Date.now()
        + Math.min(5 * 60_000, 1_000 * (2 ** Math.min(8, attempt)));
      await this.scheduleResponsibilityWakeAt(
        payload.ownerUid,
        payload.generation,
        retryAt,
        state.taskId,
      );
    }
  }
}
