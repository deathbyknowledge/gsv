import type {
  JsonObject,
  JsonValue,
  MessageAttachment,
} from "@humansandmachines/gsv/protocol";
import {
  emitTelemetry,
} from "@humansandmachines/gsv/telemetry";
import {
  type IpcCallRecord,
} from "./ipc-calls";
import {
  sendFrameToProcess,
} from "../shared/utils";
import {
  MANAGED_LIFECYCLE_RECHECK_MS,
} from "../installation/lifecycle";
import type { Kernel } from "./do";
import {
  ipcCallTimeoutPayloadSchema,
} from "./do-shared";
import type {
  IpcCallTimeout,
  UserProcessSignalFrame,
} from "./do-shared";

type IpcCallTimeoutTask = {
  id: string;
};


type IpcCallSupervisionOptions = {
  mode: "supervise";
  intervalMs: number;
  checkInCount: number;
  lifecycleRecheckFor?: string;
};


type IpcCompletionResponse = {
  text: string | null;
  usage: JsonValue;
  media?: MessageAttachment[];
};


type IpcDeliverySignalPayload = {
  callId: string;
  sourcePid: string;
  sourceRunId?: string;
  targetPid: string;
  runId: string;
  deadlineAt: number;
  createdAt: number;
  status: IpcCallRecord["status"];
  nextCheckAt?: number;
  checkInCount?: number;
  response?: IpcCallRecord["response"];
  error?: string;
};



export class IpcRuntime {
  constructor(readonly host: Kernel) {}

async scheduleIpcCallTimeout(
    callId: string,
    deadlineAt: number,
    options?: IpcCallSupervisionOptions,
  ): Promise<string> {
    const sched = await this.scheduleIpcCallTimeoutTask(callId, deadlineAt, options);
    return sched.id;
  }

async scheduleIpcCallTimeoutTask(
    callId: string,
    deadlineAt: number,
    options?: IpcCallSupervisionOptions,
  ): Promise<{ id: string; time: number }> {
    const when = new Date(
      Math.ceil(Math.max(Date.now() + 1_000, deadlineAt) / 1_000) * 1_000,
    );
    return options
      ? await this.host.schedule(
        when,
        "onIpcCallTimeout",
        { callId, ...options } satisfies IpcCallTimeout,
        { idempotent: true },
      )
      : await this.host.schedule(when, "onIpcCallTimeout", callId);
  }

failIpcCallsByTarget(uid: number, targetPid: string, error: string): void {
    for (const callId of this.host.ipcCalls.failByTargetPid({ uid, targetPid, error })) {
      const call = this.host.ipcCalls.get(callId);
      if (call) this.returnDelegatedResponsibility(call);
      this.queueIpcCallDelivery(callId);
    }
  }

async onIpcCallTimeout(
    input: string | IpcCallTimeout,
    task?: IpcCallTimeoutTask,
  ): Promise<void> {
    const timeout = ipcCallTimeoutPayloadSchema.parse(input);
    const callId = timeout.callId;
    const call = this.host.ipcCalls.get(callId);
    if (
      call
      && call.status === "pending"
      && (timeout.mode === "supervise" || timeout.terminateTargetOnTimeout === true)
    ) {
      await this.continueSupervisedIpcCall(timeout, call, task);
      return;
    }
    const timedOut = this.host.ipcCalls.timeout(callId);
    if (!timedOut) return;
    const timedOutCall = this.host.ipcCalls.get(callId);
    if (timedOutCall) this.returnDelegatedResponsibility(timedOutCall);
    this.queueIpcCallDelivery(callId);
  }

async continueSupervisedIpcCall(
    timeout: IpcCallTimeout,
    call: IpcCallRecord,
    task?: IpcCallTimeoutTask,
  ): Promise<void> {
    const derivedIntervalMs = call.deadlineAt - call.createdAt;
    const intervalMs = Math.max(
      1_000,
      Math.trunc(timeout.intervalMs ?? derivedIntervalMs),
    );
    const gate = await this.host.onboarding.managedWorkGate();
    if (!gate.allowed) {
      if (!task) {
        throw new Error("Supervision lifecycle recheck requires its scheduled task identity");
      }
      await this.scheduleIpcCallTimeoutTask(
        call.callId,
        Date.now() + MANAGED_LIFECYCLE_RECHECK_MS,
        {
          mode: "supervise",
          intervalMs,
          checkInCount: timeout.checkInCount ?? 0,
          lifecycleRecheckFor: task.id,
        },
      );
      return;
    }

    const checkInCount = (timeout.checkInCount ?? 0) + 1;
    const successor = await this.scheduleIpcCallTimeoutTask(
      call.callId,
      Date.now() + intervalMs,
      {
        mode: "supervise",
        intervalMs,
        checkInCount,
      },
    );
    const nextCheckAt = successor.time * 1_000;
    const checkedAt = nextCheckAt - intervalMs;
    const renewed = this.host.ipcCalls.renewDeadline(call.callId, nextCheckAt);
    if (!renewed) return;

    this.recordDelegationCheckIn(renewed, checkedAt, nextCheckAt, checkInCount);
    const payload: IpcDeliverySignalPayload = {
      callId: renewed.callId,
      sourcePid: renewed.sourcePid,
      targetPid: renewed.targetPid,
      runId: renewed.targetRunId,
      deadlineAt: checkedAt,
      nextCheckAt,
      checkInCount,
      createdAt: renewed.createdAt,
      status: "pending",
    };
    if (renewed.sourceRunId) payload.sourceRunId = renewed.sourceRunId;
    await sendFrameToProcess(this.host.installationId, renewed.sourcePid, {
      type: "sig",
      signal: "ipc.overdue",
      payload,
    });
  }

recordDelegationCheckIn(
    call: IpcCallRecord,
    checkedAt: number,
    nextCheckAt: number,
    checkInCount: number,
  ): void {
    if (!call.responsibilityId) return;
    const current = this.host.responsibilities.get(call.ownerUid, call.responsibilityId);
    if (
      !current
      || current.state === "resolved"
      || current.state === "cancelled"
      || current.assignee.kind !== "process"
      || current.assignee.processId !== call.targetPid
    ) {
      return;
    }

    const eventType = "process.delegation.check_in";
    const outcome = this.host.responsibilities.update({
      ownerUid: call.ownerUid,
      id: current.id,
      expectedRevision: current.revision,
      patch: {
        details: {
          ...current.details,
          delegation: {
            eventType,
            callId: call.callId,
            processId: call.targetPid,
            runId: call.targetRunId,
            status: "pending",
            checkedAtMs: checkedAt,
            nextCheckAtMs: nextCheckAt,
            checkInCount,
          },
        },
        nextCheckAtMs: nextCheckAt,
        leaseExpiresAtMs: nextCheckAt,
      },
      actor: {
        kind: "event",
        eventType,
        eventId: `${call.callId}:${checkInCount}`,
      },
      observedByShip: false,
      now: checkedAt,
    });
    if (!outcome.changed) return;
    this.host.ctx.waitUntil(this.host.responsibilityRuntime.reconcileResponsibilityWake(call.ownerUid).catch((error) => {
      console.warn("[Kernel] Failed to schedule delegated process check-in:", error);
    }));
  }

async onIpcCallDelivery(callId: string): Promise<void> {
    await this.deliverIpcCall(callId);
  }

queueIpcCallDelivery(callId: string): void {
    this.host.ctx.waitUntil(this.host.schedule(
      new Date(Date.now() + 10),
      "onIpcCallDelivery",
      callId,
      {
        idempotent: true,
        retry: { maxAttempts: 10, baseDelayMs: 1_000, maxDelayMs: 30_000 },
      },
    ).catch(() => this.deliverIpcCall(callId)));
  }

async deliverIpcCall(callId: string): Promise<void> {
    const call = this.host.ipcCalls.claimDelivery(callId);
    if (!call) {
      return;
    }
    try {
      this.returnDelegatedResponsibility(call);
      if (call.responsibilityId && !this.host.procs.get(call.sourcePid)) {
        this.host.ipcCalls.remove(callId);
        return;
      }
      await this.deliverIpcCallSignal(call);
      this.host.ipcCalls.remove(callId);
    } catch (error) {
      this.host.ipcCalls.releaseDelivery(callId);
      console.warn(`[Kernel] Failed to deliver IPC call ${callId}:`, error);
      await this.host.schedule(5, "onIpcCallDelivery", callId, {
        idempotent: false,
        retry: { maxAttempts: 10, baseDelayMs: 1_000, maxDelayMs: 30_000 },
      });
    }
  }

async deliverIpcCallSignal(call: IpcCallRecord): Promise<void> {
    const payload: IpcDeliverySignalPayload = {
      callId: call.callId,
      sourcePid: call.sourcePid,
      targetPid: call.targetPid,
      runId: call.targetRunId,
      deadlineAt: call.deadlineAt,
      createdAt: call.createdAt,
      status: call.status,
    };
    if (call.sourceRunId) payload.sourceRunId = call.sourceRunId;
    if (call.status === "completed") payload.response = call.response;
    if (call.error) payload.error = call.error;
    await sendFrameToProcess(this.host.installationId, call.sourcePid, {
      type: "sig",
      signal: call.status === "timed_out" ? "ipc.timeout" : "ipc.reply",
      payload,
    });
  }

completeIpcCallsForProcessSignal(
    processId: string,
    frame: UserProcessSignalFrame,
  ): void {
    if (frame.signal !== "proc.run.finished") {
      return;
    }
    const runId = frame.payload?.runId?.trim() || null;
    if (!runId) {
      return;
    }
    const ownerUid = this.host.procs.getOwnerUid(processId);
    if (ownerUid === null) {
      return;
    }

    const payload = frame.payload;
    const response: IpcCompletionResponse = {
      text: payload?.result?.text ?? null,
      usage: payload?.usage ?? null,
    };
    if (payload?.result?.media?.length) response.media = payload.result.media;
    const status = payload?.status ?? "ok";
    const reason = payload?.reason ?? null;
    const error = payload?.error
      ? payload.error
      : status === "aborted"
        ? `Target run was aborted${reason ? `: ${reason}` : ""}`
        : status === "error"
          ? "Target run failed"
          : null;
    if (status === "aborted") {
      this.host.ipcCalls.cancelBySourceRun({
        uid: ownerUid,
        sourcePid: processId,
        sourceRunId: runId,
      });
    }
    const completed = this.host.ipcCalls.completeByRun({
      uid: ownerUid,
      targetPid: processId,
      runId,
      response,
      error,
    });

    for (const callId of completed) {
      const call = this.host.ipcCalls.get(callId);
      if (call) this.returnDelegatedResponsibility(call);
      this.queueIpcCallDelivery(callId);
    }
  }

returnDelegatedResponsibility(call: IpcCallRecord): void {
    if (!call.responsibilityId) return;
    const current = this.host.responsibilities.get(call.ownerUid, call.responsibilityId);
    if (
      !current
      || current.state === "resolved"
      || current.state === "cancelled"
      || current.assignee.kind !== "process"
      || current.assignee.processId !== call.targetPid
    ) {
      return;
    }

    const outcome = call.status === "timed_out"
      ? "timed_out"
      : call.error?.toLowerCase().includes("killed")
        ? "killed"
        : call.error
          ? "failed"
          : "completed";
    const eventType = `process.delegation.${outcome}`;
    const completedAtMs = Date.now();
    const delegation: JsonObject = {
      eventType,
      callId: call.callId,
      processId: call.targetPid,
      runId: call.targetRunId,
      status: call.status,
      completedAtMs,
    };
    if (call.sourceRunId) delegation.sourceRunId = call.sourceRunId;
    if (call.error) delegation.error = call.error.slice(0, 2_000);
    const updated = this.host.responsibilities.update({
      ownerUid: call.ownerUid,
      id: current.id,
      expectedRevision: current.revision,
      patch: {
        details: {
          ...current.details,
          delegation,
        },
        assignee: { kind: "ship" },
        state: "open",
        blocker: call.error ? call.error.slice(0, 2_000) : null,
        nextCheckAtMs: null,
        leaseExpiresAtMs: null,
      },
      actor: {
        kind: "event",
        eventType,
        eventId: call.callId,
      },
      observedByShip: false,
      now: completedAtMs,
    });
    if (updated.changed) {
      const durationMs = Math.max(0, completedAtMs - call.createdAt);
      emitTelemetry(this.host.bindings, {
        installationId: this.host.installationId,
        component: "gateway",
        event: {
          stream: "operational",
          name: "delegation.finished",
          properties: { outcome, durationMs },
        },
      });
      if (outcome === "completed") {
        emitTelemetry(this.host.bindings, {
          installationId: this.host.installationId,
          component: "gateway",
          event: {
            stream: "product",
            name: "delegation.completed",
            properties: { durationMs },
          },
        });
      }
    }
    this.host.ctx.waitUntil(this.host.responsibilityRuntime.reconcileResponsibilityWake(call.ownerUid).catch((error) => {
      console.warn("[Kernel] Failed to schedule delegated responsibility return:", error);
    }));
  }
}
