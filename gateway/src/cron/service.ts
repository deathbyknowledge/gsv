import { normalizeAgentId, resolveAgentMainSessionKey } from "../session/routing";
import { computeNextRunAtMs, validateCronSchedule } from "./schedule";
import { CronStore } from "./store";
import type {
  CronJob,
  CronJobCreate,
  CronJobPatch,
  CronPayload,
  CronPayloadPatch,
  CronRunResult,
} from "./types";

export type CronServiceDeps = {
  store: CronStore;
  cronEnabled: boolean;
  maxJobs: number;
  maxRunsPerJobHistory: number;
  maxConcurrentRuns: number;
  mainKey?: string;
  nowMs?: () => number;
  executeMainJob: (params: {
    job: CronJob;
    text: string;
    sessionKey: string;
  }) => Promise<{ status: "ok" | "error" | "skipped"; error?: string; summary?: string }>;
  logger?: Pick<Console, "log" | "warn" | "error">;
};

export class CronService {
  constructor(private readonly deps: CronServiceDeps) {}

  status(): {
    enabled: boolean;
    count: number;
    dueCount: number;
    runningCount: number;
    nextRunAtMs?: number;
    maxJobs: number;
    maxConcurrentRuns: number;
  } {
    const nowMs = this.nowMs();
    return {
      enabled: this.deps.cronEnabled,
      count: this.deps.store.countJobs(),
      dueCount: this.deps.store.countDue(nowMs),
      runningCount: this.deps.store.countRunning(),
      nextRunAtMs: this.deps.store.nextDueAtMs(),
      maxJobs: this.deps.maxJobs,
      maxConcurrentRuns: this.deps.maxConcurrentRuns,
    };
  }

  nextRunAtMs(): number | undefined {
    if (!this.deps.cronEnabled) {
      return undefined;
    }
    return this.deps.store.nextDueAtMs();
  }

  list(opts?: {
    agentId?: string;
    includeDisabled?: boolean;
    limit?: number;
    offset?: number;
  }): { jobs: CronJob[]; count: number } {
    return this.deps.store.listJobs(opts);
  }

  add(input: CronJobCreate): CronJob {
    const existing = this.deps.store.countJobs();
    if (existing >= this.deps.maxJobs) {
      throw new Error(`Cron job limit reached (${this.deps.maxJobs})`);
    }

    const nowMs = this.nowMs();
    const job = this.buildJob(input, nowMs);

    this.deps.store.createJob(job);
    this.deps.logger?.log?.(
      `[Cron] Added job ${job.id} (${job.name}) for agent ${job.agentId}`,
    );
    return job;
  }

  update(id: string, patch: CronJobPatch): CronJob {
    const current = this.requireJob(id);
    const nowMs = this.nowMs();

    if (patch.schedule) {
      validateCronSchedule(patch.schedule);
      current.schedule = patch.schedule;
    }

    if (patch.name !== undefined) {
      current.name = this.normalizeName(patch.name);
    }

    if (patch.description !== undefined) {
      current.description = this.normalizeOptionalText(patch.description);
    }

    if (patch.agentId !== undefined) {
      current.agentId = normalizeAgentId(patch.agentId);
    }

    if (patch.enabled !== undefined) {
      current.enabled = Boolean(patch.enabled);
      if (!current.enabled) {
        current.state.runningAtMs = undefined;
      }
    }

    if (patch.deleteAfterRun !== undefined) {
      current.deleteAfterRun = patch.deleteAfterRun ? true : undefined;
    }

    if (patch.sessionTarget !== undefined) {
      current.sessionTarget = patch.sessionTarget;
    }

    if (patch.wakeMode !== undefined) {
      current.wakeMode = patch.wakeMode;
    }

    if (patch.payload !== undefined) {
      current.payload = mergePayload(current.payload, patch.payload);
    }

    this.assertSupportedJobSpec(current);

    current.updatedAtMs = nowMs;
    current.state.nextRunAtMs = current.enabled
      ? computeNextRunAtMs(current.schedule, nowMs)
      : undefined;
    if (!current.enabled) {
      current.state.runningAtMs = undefined;
    }

    this.deps.store.updateJob(current);
    return current;
  }

  remove(id: string): { removed: boolean } {
    const removed = this.deps.store.removeJob(id);
    return { removed };
  }

  runs(opts?: {
    jobId?: string;
    limit?: number;
    offset?: number;
  }): ReturnType<CronStore["listRuns"]> {
    return this.deps.store.listRuns(opts);
  }

  async run(opts?: {
    id?: string;
    mode?: "due" | "force";
  }): Promise<{ ran: number; results: CronRunResult[] }> {
    const mode = opts?.mode ?? "due";
    const nowMs = this.nowMs();

    if (mode === "due" && !this.deps.cronEnabled && !opts?.id) {
      return { ran: 0, results: [] };
    }

    if (mode === "force" && !opts?.id) {
      throw new Error("cron.run with mode=force requires id");
    }

    let jobs: CronJob[] = [];
    if (opts?.id) {
      const job = this.requireJob(opts.id);
      if (mode === "due") {
        if (!job.enabled || !job.state.nextRunAtMs || nowMs < job.state.nextRunAtMs) {
          return { ran: 0, results: [] };
        }
      }
      jobs = [job];
    } else {
      jobs = this.deps.store.dueJobs(nowMs, this.deps.maxConcurrentRuns);
    }

    const results: CronRunResult[] = [];
    for (const job of jobs) {
      results.push(await this.runJob(job, { forced: mode === "force" }));
    }

    return {
      ran: results.length,
      results,
    };
  }

  private nowMs(): number {
    return this.deps.nowMs ? this.deps.nowMs() : Date.now();
  }

  private buildJob(input: CronJobCreate, nowMs: number): CronJob {
    validateCronSchedule(input.schedule);

    const job: CronJob = {
      id: crypto.randomUUID(),
      agentId: normalizeAgentId(input.agentId ?? "main"),
      name: this.normalizeName(input.name),
      description: this.normalizeOptionalText(input.description),
      enabled: input.enabled ?? true,
      deleteAfterRun: input.deleteAfterRun ? true : undefined,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      schedule: input.schedule,
      sessionTarget: input.sessionTarget ?? "main",
      wakeMode: input.wakeMode ?? "now",
      payload: input.payload,
      state: {
        nextRunAtMs:
          input.enabled ?? true
            ? computeNextRunAtMs(input.schedule, nowMs)
            : undefined,
      },
    };

    this.assertSupportedJobSpec(job);
    return job;
  }

  private requireJob(id: string): CronJob {
    const job = this.deps.store.getJob(id);
    if (!job) {
      throw new Error(`Unknown cron job id: ${id}`);
    }
    return job;
  }

  private normalizeName(name: string): string {
    const trimmed = name?.trim();
    if (!trimmed) {
      throw new Error("Cron job name is required");
    }
    return trimmed;
  }

  private normalizeOptionalText(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  }

  private assertSupportedJobSpec(job: Pick<CronJob, "sessionTarget" | "payload">): void {
    if (job.sessionTarget !== "main") {
      throw new Error(
        `cron sessionTarget=${job.sessionTarget} is not implemented yet (only main is supported)`,
      );
    }

    if (job.payload.kind !== "systemEvent") {
      throw new Error(
        `cron payload.kind=${job.payload.kind} is not implemented yet (main requires systemEvent)`,
      );
    }
  }

  private async runJob(
    job: CronJob,
    opts: { forced: boolean },
  ): Promise<CronRunResult> {
    const startedAt = this.nowMs();

    job.state.runningAtMs = startedAt;
    job.state.lastError = undefined;
    job.updatedAtMs = startedAt;
    this.deps.store.updateJob(job);

    const finish = (
      status: "ok" | "error" | "skipped",
      meta?: { error?: string; summary?: string },
    ): CronRunResult => {
      const endedAt = this.nowMs();
      const durationMs = Math.max(0, endedAt - startedAt);

      job.state.runningAtMs = undefined;
      job.state.lastRunAtMs = startedAt;
      job.state.lastStatus = status;
      job.state.lastError = meta?.error;
      job.state.lastDurationMs = durationMs;

      const isOneShot = job.schedule.kind === "at";
      if (isOneShot) {
        if (status === "ok" && job.deleteAfterRun) {
          // Delete only the job row so run history remains queryable.
          this.deps.store.updateJob({
            ...job,
            enabled: false,
            state: {
              ...job.state,
              nextRunAtMs: undefined,
            },
          });
          this.deps.store.removeJob(job.id, { deleteRuns: false });
        } else {
          job.enabled = false;
          job.state.nextRunAtMs = undefined;
          job.updatedAtMs = endedAt;
          this.deps.store.updateJob(job);
        }
      } else {
        job.state.nextRunAtMs = job.enabled
          ? computeNextRunAtMs(job.schedule, endedAt)
          : undefined;
        job.updatedAtMs = endedAt;
        this.deps.store.updateJob(job);
      }

      this.deps.store.addRun(
        {
          jobId: job.id,
          ts: endedAt,
          status,
          error: meta?.error,
          summary: meta?.summary,
          durationMs,
          nextRunAtMs: job.state.nextRunAtMs,
        },
        {
          maxHistoryPerJob: this.deps.maxRunsPerJobHistory,
        },
      );

      return {
        jobId: job.id,
        status,
        error: meta?.error,
        summary: meta?.summary,
        durationMs,
        nextRunAtMs: job.state.nextRunAtMs,
      };
    };

    if (!job.enabled && !opts.forced) {
      return finish("skipped", { error: "job disabled" });
    }

    if (!this.deps.cronEnabled && !opts.forced) {
      return finish("skipped", { error: "cron scheduler disabled" });
    }

    if (job.payload.kind !== "systemEvent") {
      return finish("skipped", {
        error: "payload.kind agentTurn is not implemented yet",
      });
    }

    const text = job.payload.text.trim();
    if (!text) {
      return finish("skipped", { error: "systemEvent payload text is empty" });
    }

    const sessionKey = resolveAgentMainSessionKey({
      agentId: job.agentId,
      mainKey: this.deps.mainKey,
    });

    try {
      const result = await this.deps.executeMainJob({ job, text, sessionKey });
      return finish(result.status, {
        error: result.error,
        summary: result.summary,
      });
    } catch (error) {
      return finish("error", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function mergePayload(current: CronPayload, patch: CronPayloadPatch): CronPayload {
  if (patch.kind !== current.kind) {
    return buildPayloadFromPatch(patch);
  }

  if (patch.kind === "systemEvent" && current.kind === "systemEvent") {
    return {
      kind: "systemEvent",
      text: patch.text !== undefined ? patch.text : current.text,
    };
  }

  if (patch.kind === "agentTurn" && current.kind === "agentTurn") {
    return {
      kind: "agentTurn",
      message: patch.message !== undefined ? patch.message : current.message,
      model: patch.model !== undefined ? patch.model : current.model,
      thinking: patch.thinking !== undefined ? patch.thinking : current.thinking,
      timeoutSeconds:
        patch.timeoutSeconds !== undefined
          ? patch.timeoutSeconds
          : current.timeoutSeconds,
      deliver: patch.deliver !== undefined ? patch.deliver : current.deliver,
      channel: patch.channel !== undefined ? patch.channel : current.channel,
      to: patch.to !== undefined ? patch.to : current.to,
      bestEffortDeliver:
        patch.bestEffortDeliver !== undefined
          ? patch.bestEffortDeliver
          : current.bestEffortDeliver,
    };
  }

  return buildPayloadFromPatch(patch);
}

function buildPayloadFromPatch(patch: CronPayloadPatch): CronPayload {
  if (patch.kind === "systemEvent") {
    if (typeof patch.text !== "string") {
      throw new Error('cron payload.kind="systemEvent" requires text');
    }
    return {
      kind: "systemEvent",
      text: patch.text,
    };
  }

  if (typeof patch.message !== "string") {
    throw new Error('cron payload.kind="agentTurn" requires message');
  }

  return {
    kind: "agentTurn",
    message: patch.message,
    model: patch.model,
    thinking: patch.thinking,
    timeoutSeconds: patch.timeoutSeconds,
    deliver: patch.deliver,
    channel: patch.channel,
    to: patch.to,
    bestEffortDeliver: patch.bestEffortDeliver,
  };
}
