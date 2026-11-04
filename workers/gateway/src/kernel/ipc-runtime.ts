import {
  bodyFromBytes,
  type JsonObject,
  type JsonValue,
  type MessageAttachment,
} from "@humansandmachines/gsv/protocol";
import {
  emitTelemetry,
} from "@humansandmachines/gsv/telemetry";
import {
  type IpcCallRecord,
} from "./ipc-calls";
import {
  MANAGED_LIFECYCLE_RECHECK_MS,
} from "../installation/lifecycle";
import { writeProcessResource } from "../shared/utils";
import { eventBodyBytes, MAX_EVENT_BODY_BYTES, type EventActor } from "./events/store";
import {
  IPC_OVERDUE, IPC_REPLY, IPC_TIMED_OUT, IPC_TIMEOUT, ipcAnswer, ipcCheckIn, ipcSubject, type IpcCallEnd,
} from "./ipc-events";
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
    this.answer(() => this.host.ipcCalls.endByTarget({ uid, targetPid }), { type: IPC_REPLY, error }, { kind: "kernel" });
  }

async onIpcCallTimeout(
    input: string | IpcCallTimeout,
    task?: IpcCallTimeoutTask,
  ): Promise<void> {
    const timeout = ipcCallTimeoutPayloadSchema.parse(input);
    const callId = timeout.callId;
    const call = this.host.ipcCalls.get(callId);
    if (call && (timeout.mode === "supervise" || timeout.terminateTargetOnTimeout === true)) {
      await this.continueSupervisedIpcCall(timeout, call, task);
      return;
    }
    this.answer(() => {
      const overdue = this.host.ipcCalls.endOverdue(callId);
      return overdue ? [overdue] : [];
    }, { type: IPC_TIMEOUT, error: IPC_TIMED_OUT }, { kind: "kernel" });
  }

  /**
   * Ends calls and appends each one's answer for its caller in one transaction, so a
   * call's row and its answer never both exist. The ledger then takes back delegated work.
   */
  private answer(end: () => IpcCallRecord[], how: IpcCallEnd, actor: EventActor): void {
    const ended = this.host.events.transaction(() => end().map((call) => {
      this.host.eventRuntime.append(ipcAnswer(call, how, actor));
      return call;
    }));
    if (ended.length === 0) return;
    for (const call of ended) this.returnDelegatedResponsibility(call, how);
    this.host.ctx.waitUntil(this.host.eventRuntime.kick().catch((error) => {
      console.warn("[Kernel] Failed to arm IPC answer delivery:", error);
    }));
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
    const renewed = this.host.events.transaction(() => {
      const record = this.host.ipcCalls.renewDeadline(call.callId, nextCheckAt);
      if (!record) return null;
      // The caller hears the latest check-in, not a backlog of them.
      for (const older of this.host.eventRuntime.pending(IPC_OVERDUE, ipcSubject(record.callId))) {
        this.host.eventRuntime.withdraw(older, "a newer check-in replaced it");
      }
      this.host.eventRuntime.append(ipcCheckIn(record, { checkedAt, nextCheckAt, checkInCount }));
      return record;
    });
    if (!renewed) return;

    this.recordDelegationCheckIn(renewed, checkedAt, nextCheckAt, checkInCount);
    await this.host.eventRuntime.kick();
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

async completeIpcCallsForProcessSignal(
    processId: string,
    frame: UserProcessSignalFrame,
  ): Promise<void> {
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
    if (status !== "ok" && status !== "error" && status !== "aborted") {
      throw new Error("Invalid process run completion status");
    }
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
    const call = this.host.ipcCalls.findPendingByTargetRun({ uid: ownerUid, targetPid: processId, targetRunId: runId });
    if (!call) return;
    const end = await this.fitAnswer(call, {
      type: IPC_REPLY,
      runStatus: status,
      response,
      ...(error ? { error } : undefined),
    });
    this.answer(
      () => this.host.ipcCalls.endByRun({ uid: ownerUid, targetPid: processId, runId }),
      end,
      { kind: "process", pid: processId },
    );
  }

  /**
   * Fits an answer in its event. Text too large for one moves into a file in the caller's
   * own home, which reaches the caller as an attachment; the worker's own files stay in
   * the response.
   */
  private async fitAnswer(call: IpcCallRecord, end: IpcCallEnd & { response: IpcCompletionResponse }): Promise<IpcCallEnd> {
    const answer = ipcAnswer(call, end, { kind: "kernel" });
    const { text, media } = end.response;
    if (text === null || eventBodyBytes(answer.body ?? null) <= MAX_EVENT_BODY_BYTES) return end;
    const written = await writeProcessResource(this.host.installationId, call.sourcePid, {
      resourceId: `${call.callId}:answer`,
      mediaType: "document",
      contentType: "text/markdown",
      filename: "answer.md",
    }, bodyFromBytes(new TextEncoder().encode(text)));
    if ("unavailable" in written) {
      // A caller that is gone hears nothing; its answer's delivery is withdrawn with it.
      if (written.unavailable === "killed") return { ...end, response: undefined };
      throw new Error(written.message);
    }
    return { ...end, response: media ? { media } : undefined, attachments: [written.resource] };
  }

returnDelegatedResponsibility(call: IpcCallRecord, end: IpcCallEnd): void {
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

    const { runStatus, error } = end;
    const outcome = end.type === IPC_TIMEOUT
      ? "timed_out"
      : runStatus === "aborted"
        ? "aborted"
        : error?.toLowerCase().includes("killed")
          ? "killed"
          : error
            ? "failed"
            : "completed";
    const eventType = `process.delegation.${outcome}`;
    const completedAtMs = Date.now();
    const delegation: JsonObject = {
      eventType,
      callId: call.callId,
      processId: call.targetPid,
      runId: call.targetRunId,
      status: end.type === IPC_TIMEOUT ? "timed_out" : "completed",
      completedAtMs,
    };
    if (runStatus) delegation.runStatus = runStatus;
    if (call.sourceRunId) delegation.sourceRunId = call.sourceRunId;
    if (error) delegation.error = error.slice(0, 2_000);
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
        blocker: error ? error.slice(0, 2_000) : null,
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
