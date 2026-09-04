import type {
  JsonObject,
  ProcessIdentity,
  ScheduleRecord,
  ScheduleRunResult,
  SchedulerRunArgs,
  SchedulerRunResult,
} from "@humansandmachines/gsv/protocol";
import {
  hasCapability,
} from "./capabilities";
import {
  assertCanManageSchedule,
  computeNextRunAfterFinish,
  skippedScheduleResult,
} from "./scheduler";
import type {
  KernelContext,
} from "./context";
import { principalOf, type PrincipalView } from "./context";
import {
  kernelPeerContext,
} from "./peer";
import {
  sendFrameToProcess,
} from "../shared/utils";
import {
  stableOpaqueId,
} from "../shared/stable-id";
import {
  deliverAdapterDestination,
} from "./adapter-send";
import {
  assertAdapterMessageDestinationAccess,
  identityLinkRouteGeneration,
} from "./adapter-destinations";
import type {
  InternalRequestFrame,
  InternalResponseFrame,
} from "../protocol/process-frames";
import {
  handleProcSpawn,
} from "./proc-handlers";
import {
  handleShellExec,
} from "../drivers/native/shell";
import {
  MANAGED_LIFECYCLE_RECHECK_MS,
} from "../installation/lifecycle";
import type { Kernel } from "./do";

const MAX_ONE_SHOT_SCHEDULE_DELIVERY_ATTEMPTS = 10;

class ScheduleTargetDispatchError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = "ScheduleTargetDispatchError";
  }
}


function scheduleDeliveryRetryDelayMs(attempt: number): number {
  return Math.min(5 * 60_000, 5_000 * (2 ** Math.max(0, attempt - 1)));
}


type ScheduleExecutionResult = {
  kind?: "command.exec" | "process.spawn" | "adapter.send" | "process.event" | "responsibility" | "unknown";
  error?: string;
  command?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  truncated?: boolean;
  pid?: string;
  runId?: string;
  adapter?: string;
  accountId?: string;
  surfaceId?: string;
  messageId?: string;
  deliveryState?: string;
  responsibilityId?: string;
};


function scheduleResultSummary(record: ScheduleRecord, result: ScheduleExecutionResult): string {
  if (record.target.kind === "command.exec") {
    return result.exitCode !== undefined
      ? `command exited ${result.exitCode}`
      : "command failed";
  }
  if (record.target.kind === "process.spawn" && result.pid) {
    return `spawned process ${result.pid}`;
  }
  if (record.target.kind === "process.event") {
    if (result.responsibilityId && result.kind === "responsibility") {
      return `created responsibility ${result.responsibilityId}`;
    }
    return `delivered event to process ${record.target.pid}`;
  }
  if (record.target.kind === "responsibility" && result.responsibilityId) {
    return `created responsibility ${result.responsibilityId}`;
  }
  if (record.target.kind === "adapter.send") {
    if (result.deliveryState === "ambiguous") {
      return `message delivery through ${record.target.destination.adapter} is ambiguous`;
    }
    if (result.deliveryState === "deduplicated") {
      return `message through ${record.target.destination.adapter} was already delivered`;
    }
    return `sent message through ${record.target.destination.adapter}`;
  }
  return "schedule ran";
}



export class ScheduleRuntime {
  constructor(readonly host: Kernel) {}

async onScheduleDue(scheduleId: string, wake?: { id?: string }): Promise<void> {
    const record = this.host.schedules.getStored(scheduleId);
    const wakeId = wake?.id ?? null;
    if (wakeId && record?.wakeScheduleId !== wakeId) {
      return;
    }

    const gate = await this.host.onboarding.managedWorkGate();
    if (!gate.allowed) {
      if (record?.enabled && record.state.nextRunAtMs !== null) {
        const nextWakeId = await this.scheduleScheduleWake(
          record.id,
          Date.now() + MANAGED_LIFECYCLE_RECHECK_MS,
        );
        this.host.schedules.setWakeScheduleId(record.id, nextWakeId);
      }
      return;
    }

    const result = await this.runSchedules({ id: scheduleId, mode: "due" });
    if (result.ran !== 0) {
      return;
    }

    const current = this.host.schedules.getStored(scheduleId);
    if (current?.enabled && current.state.nextRunAtMs !== null && current.state.nextRunAtMs > Date.now()) {
      const nextWakeId = await this.scheduleScheduleWake(current.id, current.state.nextRunAtMs);
      this.host.schedules.setWakeScheduleId(current.id, nextWakeId);
    }
  }

async runSchedules(
    args: SchedulerRunArgs,
    identity?: PrincipalView,
    callerOwnerUid = identity?.account.uid,
  ): Promise<SchedulerRunResult> {
    const mode = args.mode ?? "due";
    if (mode === "force" && !args.id) {
      throw new Error("sched.run force requires an id");
    }

    const now = Date.now();
    const records = args.id
      ? [this.host.schedules.get(args.id)].filter((record): record is ScheduleRecord => record !== null)
      : this.host.schedules.listDue(now, callerOwnerUid !== undefined && callerOwnerUid !== 0 ? callerOwnerUid : undefined);

    const gate = await this.host.onboarding.managedWorkGate();
    if (!gate.allowed) {
      return {
        ran: 0,
        results: records.map((record) =>
          skippedScheduleResult(record.id, gate.message)
        ),
      };
    }

    const results: ScheduleRunResult[] = [];
    for (const record of records) {
      if (identity) {
        assertCanManageSchedule(identity, record, callerOwnerUid);
      }
      results.push(await this.runScheduleRecord(record, mode));
    }

    return {
      ran: results.filter((result) => result.status !== "skipped").length,
      results,
    };
  }

async runScheduleRecord(
    record: ScheduleRecord,
    mode: "due" | "force",
  ): Promise<ScheduleRunResult> {
    const now = Date.now();
    const scheduledAtMs = record.state.nextRunAtMs;

    if (mode === "due") {
      if (!record.enabled) {
        return skippedScheduleResult(record.id, "schedule is disabled");
      }
      if (scheduledAtMs === null || scheduledAtMs > now) {
        return skippedScheduleResult(record.id, "schedule is not due");
      }
    }

    const startedAtMs = Date.now();
    const running = this.host.schedules.markRunning(record.id, startedAtMs);
    if (!running) {
      return skippedScheduleResult(record.id, "schedule is already running");
    }

    let status: "ok" | "error" = "ok";
    let error: string | undefined;
    let result: ScheduleExecutionResult;
    let retryableFailure = false;
    const oneShot = running.expression.kind === "at" || running.expression.kind === "after";
    const occurrenceKey = this.host.schedules.occurrenceKey(
      running,
      mode,
      scheduledAtMs,
      startedAtMs,
    );
    const oneShotAttemptNumber = this.host.schedules.oneShotAttemptNumber(running, mode);

    try {
      result = await this.dispatchScheduleTarget(
        record,
        scheduledAtMs,
        startedAtMs,
        occurrenceKey,
      );
    } catch (err) {
      status = "error";
      error = err instanceof Error ? err.message : String(err);
      retryableFailure = err instanceof ScheduleTargetDispatchError && err.retryable;
      result = { error };
    }

    const finishedAtMs = Date.now();
    const retryOneShot = mode === "due"
      && oneShot
      && status === "error"
      && retryableFailure
      && oneShotAttemptNumber !== null
      && oneShotAttemptNumber < MAX_ONE_SHOT_SCHEDULE_DELIVERY_ATTEMPTS;
    const next = mode === "force"
      ? { enabled: record.enabled, nextRunAtMs: record.state.nextRunAtMs }
      : retryOneShot
        ? {
            enabled: true,
            nextRunAtMs: finishedAtMs + scheduleDeliveryRetryDelayMs(oneShotAttemptNumber),
          }
        : computeNextRunAfterFinish(
            record.expression,
            Math.max(finishedAtMs, scheduledAtMs ?? finishedAtMs),
          );
    const updated = this.host.schedules.finishRun({
      scheduleId: record.id,
      ownerUid: record.ownerUid,
      scheduledAtMs: mode === "force" ? null : scheduledAtMs,
      startedAtMs,
      finishedAtMs,
      status,
      error,
      result,
      nextRunAtMs: next.nextRunAtMs,
      enabled: next.enabled,
      oneShotOccurrenceId: running.oneShotOccurrenceId,
      countOneShotAttempt: oneShotAttemptNumber !== null,
    });

    if (updated?.enabled && updated.state.nextRunAtMs !== null && mode !== "force") {
      const wakeId = await this.scheduleScheduleWake(updated.id, updated.state.nextRunAtMs);
      this.host.schedules.setWakeScheduleId(updated.id, wakeId);
    } else if (updated && !updated.enabled) {
      this.host.schedules.setWakeScheduleId(updated.id, null);
    }

    const runResult: ScheduleRunResult = {
      scheduleId: record.id,
      status,
      summary: scheduleResultSummary(record, result),
      durationMs: Math.max(0, finishedAtMs - startedAtMs),
      nextRunAtMs: updated?.state.nextRunAtMs ?? null,
    };
    if (error) runResult.error = error;
    return runResult;
  }

async dispatchScheduleTarget(
    record: ScheduleRecord,
    scheduledAtMs: number | null,
    firedAtMs: number,
    occurrenceKey: string,
  ): Promise<ScheduleExecutionResult> {
    const target = record.target;
    const ctx = {
      ...this.buildScheduleContext(record),
      requestId: target.kind === "command.exec"
        ? `schedule:${record.id}:${occurrenceKey}`
        : occurrenceKey,
    };
    if (target.kind === "command.exec") {
      if (!hasCapability(principalOf(ctx)?.calls ?? [], "shell.exec")) {
        throw new Error("Permission denied: shell.exec");
      }
      const deps = this.host.buildDispatchDeps();
      const result = await handleShellExec(
        {
          input: target.command,
          cwd: target.cwd,
          timeout: target.timeoutMs,
        },
        ctx,
        {
          fsTransport: deps,
          netFetchTransport: deps,
          request: (frame, signal) => deps.request(frame, ctx, signal),
        },
      );
      if (result.status !== "completed") {
        throw new Error(result.status === "failed" ? result.error : `Command ${result.status}`);
      }
      return {
        kind: "command.exec",
        command: target.command,
        exitCode: result.exitCode,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        truncated: result.truncated === true,
      };
    }

    if (target.kind === "process.spawn") {
      if (!hasCapability(principalOf(ctx)?.calls ?? [], "proc.spawn")) {
        throw new Error("Permission denied: proc.spawn");
      }
      const runAs = this.resolveScheduledSpawnRunAs(record, target.runAs);
      const spawnArgs: Parameters<typeof handleProcSpawn>[0] = {
        interactive: false,
        label: target.label ?? record.name,
        prompt: target.prompt,
        parentPid: target.parentPid,
        cwd: target.cwd,
      };
      if (runAs) spawnArgs.runAs = runAs;
      const result = await handleProcSpawn(spawnArgs, ctx);
      if (!result.ok) {
        throw new Error(result.error);
      }
      return {
        kind: "process.spawn",
        pid: result.pid,
      };
    }

    if (target.kind === "adapter.send") {
      if (!hasCapability(principalOf(ctx)?.calls ?? [], "adapter.send")) {
        throw new Error("Permission denied: adapter.send");
      }
      const delivery = await deliverAdapterDestination(
        target.destination,
        record.ownerUid,
        {
          deliveryId: await stableOpaqueId("adapter-delivery", [
            "schedule",
            record.id,
            occurrenceKey,
          ]),
          text: target.text,
        },
        ctx,
      );
      if (!delivery.ok) {
        throw new ScheduleTargetDispatchError(delivery.error, delivery.retryable === true);
      }
      return {
        kind: "adapter.send",
        adapter: delivery.adapter,
        accountId: delivery.accountId,
        surfaceId: delivery.surfaceId,
        messageId: delivery.messageId,
        deliveryState: delivery.deliveryState,
      };
    }

    if (target.kind === "responsibility") {
      if (!hasCapability(principalOf(ctx)?.calls ?? [], "r12y.create")) {
        throw new Error("Permission denied: r12y.create");
      }
      const responsibilityId = this.createScheduleResponsibility(
        record,
        target,
        scheduledAtMs,
        firedAtMs,
        occurrenceKey,
      );
      return {
        kind: "responsibility",
        responsibilityId,
      };
    }

    if (target.kind === "process.event") {
      if (!hasCapability(principalOf(ctx)?.calls ?? [], "proc.send")) {
        throw new Error("Permission denied: proc.send");
      }
      if (
        target.replyTo
        && !hasCapability(principalOf(ctx)?.calls ?? [], "adapter.send")
      ) {
        throw new Error("Permission denied: adapter.send");
      }
      const proc = this.host.procs.get(target.pid);
      if (!proc) {
        throw new Error(`Process not found: ${target.pid}`);
      }
      if (proc.ownerUid !== record.ownerUid && record.ownerUid !== 0) {
        throw new Error(`Permission denied: schedule ${record.id} cannot access process ${target.pid}`);
      }
      if (proc.isPersonalController) {
        if (!hasCapability(principalOf(ctx)?.calls ?? [], "r12y.create")) {
          throw new Error("Permission denied: r12y.create");
        }
        return {
          kind: "responsibility",
          responsibilityId: this.createScheduleResponsibility(
            record,
            target,
            scheduledAtMs,
            firedAtMs,
            occurrenceKey,
          ),
        };
      }
      if (target.replyTo) {
        assertAdapterMessageDestinationAccess(target.replyTo, record.ownerUid, ctx);
      }

      const runId = await stableOpaqueId("schedule-run", [record.id, occurrenceKey]);
      const delivery = target.replyTo;
      if (delivery) {
        const link = ctx.adapters.identityLinks.get(
          delivery.adapter,
          delivery.accountId,
          delivery.actorId,
        );
        const routeGeneration = link
          ? identityLinkRouteGeneration(link, delivery.surface)
          : undefined;
        this.host.runRoutes.setAdapterRoute({
          runId,
          processId: target.pid,
          uid: record.ownerUid,
          destination: delivery,
          ...(routeGeneration === undefined ? undefined : { routeGeneration }),
        });
      }
      const request: InternalRequestFrame<"proc.schedule.deliver"> = {
        type: "req",
        id: crypto.randomUUID(),
        call: "proc.schedule.deliver",
        args: {
          runId,
          scheduleId: record.id,
          scheduleName: record.name,
          message: target.message,
          data: target.data,
          replyTo: target.replyTo,
          scheduledAtMs,
          firedAtMs,
        },
      };
      let admittedRunId = runId;
      let response: InternalResponseFrame<"proc.schedule.deliver"> | null;
      try {
        response = await sendFrameToProcess(this.host.installationId, target.pid, request);
      } catch (error) {
        // As with adapter ingress, a thrown DO transport may have lost the
        // response after admission. Preserve a preallocated reply route so an
        // actually admitted run can still complete its delivery.
        throw new ScheduleTargetDispatchError(
          error instanceof Error ? error.message : String(error),
          true,
        );
      }
      if (!response || response.type !== "res" || response.id !== request.id) {
        throw new ScheduleTargetDispatchError(
          "proc.schedule.deliver did not return a response",
          true,
        );
      }
      if (!response.ok) {
        throw new ScheduleTargetDispatchError(response.error.message, true);
      }
      admittedRunId = response.data.runId;
      if (delivery && response.data.runId !== runId) {
        this.host.runRoutes.delete(runId);
        throw new ScheduleTargetDispatchError(
          "proc.schedule.deliver admitted an unexpected reply run",
          false,
        );
      }
      const result: ScheduleExecutionResult = {
        kind: "process.event",
        pid: target.pid,
        runId: admittedRunId,
      };
      return result;
    }

    return { kind: "unknown" };
  }

createScheduleResponsibility(
    record: ScheduleRecord,
    target: Extract<ScheduleRecord["target"], { kind: "responsibility" | "process.event" }>,
    scheduledAtMs: number | null,
    firedAtMs: number,
    occurrenceKey: string,
  ): string {
    const details: JsonObject = {
      eventType: "schedule.due",
      scheduleId: record.id,
      occurrenceKey,
      scheduledAtMs,
      firedAtMs,
      message: target.message,
    };
    if (target.data !== undefined) details.data = target.data;
    const outcome = this.host.responsibilities.create({
      ownerUid: record.ownerUid,
      title: `Run scheduled responsibility: ${record.name}`,
      details,
      source: { kind: "schedule", scheduleId: record.id },
      assignee: { kind: "ship" },
      state: "open",
      priority: target.kind === "responsibility"
        ? target.priority ?? "normal"
        : "normal",
      dedupeKey: `schedule.due:${record.id}:${occurrenceKey}`,
      actor: { kind: "system", component: "scheduler" },
      observedByShip: false,
      now: firedAtMs,
    });
    this.host.ctx.waitUntil(this.host.responsibilityRuntime.reconcileResponsibilityWake(record.ownerUid).catch((error) => {
      console.warn("[Kernel] Failed to schedule due responsibility:", error);
    }));
    return outcome.record.id;
  }

buildScheduleContext(record: ScheduleRecord): KernelContext {
    const identity = this.resolveScheduleIdentity(record);
    return this.host.buildKernelContext({
      peer: kernelPeerContext({
        installationId: this.host.installationId,
        identity,
        calls: this.host.caps.resolve(identity.gids),
      }),
      callerOwnerUid: record.ownerUid,
    });
  }

resolveScheduleIdentity(record: ScheduleRecord): ProcessIdentity {
    const uid = record.runAs.uid;
    const account = this.host.auth.getPasswdByUid(uid);
    if (!account) {
      throw new Error(`Cannot resolve schedule run-as uid ${uid}`);
    }

    return {
      uid: account.uid,
      gid: account.gid,
      gids: this.host.auth.resolveGids(account.username, account.gid),
      username: account.username,
      home: account.home,
      cwd: account.home,
    };
  }

resolveScheduledSpawnRunAs(record: ScheduleRecord, targetRunAs?: string): string | undefined {
    if (targetRunAs) {
      return targetRunAs;
    }
    // A process-principal schedule records a run-as account and an origin pid.
    // Execution must keep the account without depending on that pid still being
    // alive as the spawn parent.
    return record.runAs.kind === "process" || record.runAs.kind === "service"
      ? record.runAs.username
      : undefined;
  }

async scheduleScheduleWake(scheduleId: string, dueAtMs: number): Promise<string> {
    const wakeAt = new Date(Math.ceil(Math.max(Date.now() + 1_000, dueAtMs) / 1_000) * 1_000);
    const sched = await this.host.schedule(
      wakeAt,
      "onScheduleDue",
      scheduleId,
    );
    return sched.id;
  }
}
