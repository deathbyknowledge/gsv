import type { KernelContext } from "./context";
import { assertLocalUserKernelUid, resolveCallerOwnerUid } from "./context";
import { hasCapability } from "./capabilities";
import { packageAgentRuntimeSecurityRevision } from "./package-agents";
import type {
  ConnectionIdentity,
  ScheduleExpression,
  SchedulePrincipal,
  ScheduleRecord,
  SchedulerAddArgs,
  SchedulerAddResult,
  SchedulerListArgs,
  SchedulerListResult,
  SchedulerRemoveArgs,
  SchedulerRemoveResult,
  SchedulerRunArgs,
  SchedulerRunResult,
  SchedulerUpdateArgs,
  SchedulerUpdateResult,
  ScheduleRunHistoryEntry,
  ScheduleRunResult,
  ScheduleTarget,
} from "@humansandmachines/gsv/protocol";

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;
const MIN_INTERVAL_MS = 1_000;
const MAX_CRON_SCAN_MINUTES = 366 * 24 * 60 * 5;

type ScheduleRow = {
  schedule_id: string;
  owner_uid: number;
  creator_json: string;
  run_as_json: string;
  package_security_revision: string | null;
  name: string;
  description: string | null;
  enabled: number;
  expression_json: string;
  target_json: string;
  overlap_policy: string;
  wake_schedule_id: string | null;
  next_run_at: number | null;
  running_at: number | null;
  last_run_at: number | null;
  last_status: string | null;
  last_error: string | null;
  last_duration_ms: number | null;
  run_count: number;
  created_at: number;
  updated_at: number;
};

type ScheduleRunRow = {
  run_id: string;
  schedule_id: string;
  scheduled_at: number | null;
  started_at: number;
  finished_at: number;
  status: string;
  error: string | null;
  result_json: string;
};

type InterruptedScheduleRow = {
  schedule_id: string;
  owner_uid: number;
  running_at: number;
};

export type CronFileRecord = {
  path: string;
  ownerUid: number | null;
  content: string;
  createdAtMs: number;
  updatedAtMs: number;
};

type CronFileRow = {
  path: string;
  owner_uid: number | null;
  content: string;
  created_at: number;
  updated_at: number;
};

type CronFileScheduleRow = {
  schedule_id: string;
};

export type StoredScheduleRecord = ScheduleRecord & {
  wakeScheduleId: string | null;
  packageSecurityRevision: string | null;
};

export class ScheduleStore {
  constructor(private readonly sql: SqlStorage) {}

  create(input: {
    ownerUid: number;
    creator: SchedulePrincipal;
    runAs: SchedulePrincipal;
    packageSecurityRevision?: string;
    name: string;
    description?: string;
    enabled: boolean;
    expression: ScheduleExpression;
    target: ScheduleTarget;
    now: number;
  }): ScheduleRecord {
    const id = crypto.randomUUID();
    const nextRunAt = input.enabled ? computeNextRunAt(input.expression, input.now) : null;
    this.sql.exec(
      `INSERT INTO schedules (
        schedule_id, owner_uid, creator_json, run_as_json, package_security_revision, name, description,
        enabled, expression_json, target_json, overlap_policy, wake_schedule_id,
        next_run_at, running_at, last_run_at, last_status, last_error,
        last_duration_ms, run_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'skip', NULL, ?, NULL, NULL, NULL, NULL, NULL, 0, ?, ?)`,
      id,
      input.ownerUid,
      JSON.stringify(input.creator),
      JSON.stringify(input.runAs),
      input.packageSecurityRevision ?? null,
      input.name,
      input.description ?? null,
      input.enabled ? 1 : 0,
      JSON.stringify(input.expression),
      JSON.stringify(input.target),
      nextRunAt,
      input.now,
      input.now,
    );

    const record = this.get(id);
    if (!record) {
      throw new Error(`Failed to create schedule ${id}`);
    }
    return record;
  }

  get(id: string): ScheduleRecord | null {
    const stored = this.getStored(id);
    return stored ? publicRecord(stored) : null;
  }

  getStored(id: string): StoredScheduleRecord | null {
    const rows = this.sql.exec<ScheduleRow>(
      "SELECT * FROM schedules WHERE schedule_id = ? LIMIT 1",
      id,
    ).toArray();
    return rows[0] ? toRecord(rows[0]) : null;
  }

  list(args: {
    ownerUid?: number;
    includeDisabled?: boolean;
    limit?: number;
    offset?: number;
  }): { records: ScheduleRecord[]; count: number } {
    const limit = clampListLimit(args.limit);
    const offset = Math.max(0, Math.trunc(args.offset ?? 0));
    const clauses: string[] = [];
    const bindings: unknown[] = [];

    if (args.ownerUid !== undefined) {
      clauses.push("owner_uid = ?");
      bindings.push(args.ownerUid);
    }
    if (!args.includeDisabled) {
      clauses.push("enabled = 1");
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const countRows = this.sql.exec<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM schedules ${where}`,
      ...bindings,
    ).toArray();
    const rows = this.sql.exec<ScheduleRow>(
      `SELECT * FROM schedules ${where}
       ORDER BY CASE WHEN next_run_at IS NULL THEN 1 ELSE 0 END,
                next_run_at ASC,
                updated_at DESC
       LIMIT ? OFFSET ?`,
      ...bindings,
      limit,
      offset,
    ).toArray();

    return {
      records: rows.map((row) => publicRecord(toRecord(row))),
      count: countRows[0]?.cnt ?? 0,
    };
  }

  listDue(now: number, ownerUid?: number): StoredScheduleRecord[] {
    const clauses = [
      "enabled = 1",
      "next_run_at IS NOT NULL",
      "next_run_at <= ?",
    ];
    const bindings: unknown[] = [now];
    if (ownerUid !== undefined) {
      clauses.push("owner_uid = ?");
      bindings.push(ownerUid);
    }
    return this.sql.exec<ScheduleRow>(
      `SELECT * FROM schedules
       WHERE ${clauses.join(" AND ")}
       ORDER BY next_run_at ASC, schedule_id ASC`,
      ...bindings,
    ).toArray().map(toRecord);
  }

  /**
   * Return every enabled, idle schedule that should own a one-shot wake.
   * Lifecycle recovery must include future schedules because its persisted
   * Agent wake may have been consumed or may belong to the fenced runtime.
   */
  listWakeable(): StoredScheduleRecord[] {
    return this.sql.exec<ScheduleRow>(
      `SELECT * FROM schedules
       WHERE enabled = 1
         AND next_run_at IS NOT NULL
         AND running_at IS NULL
       ORDER BY next_run_at ASC, schedule_id ASC`,
    ).toArray().map(toRecord);
  }

  listStored(): StoredScheduleRecord[] {
    return this.sql.exec<ScheduleRow>(
      "SELECT * FROM schedules ORDER BY schedule_id ASC",
    ).toArray().map(toRecord);
  }

  update(id: string, patch: {
    name?: string;
    description?: string | null;
    enabled?: boolean;
    expression?: ScheduleExpression;
    target?: ScheduleTarget;
    now: number;
  }): ScheduleRecord {
    const current = this.getStored(id);
    if (!current) {
      throw new Error(`Schedule not found: ${id}`);
    }

    const expression = patch.expression ?? current.expression;
    const enabled = patch.enabled ?? current.enabled;
    const nextRunAt = enabled
      ? (patch.expression || patch.enabled !== undefined
          ? computeNextRunAt(expression, patch.now)
          : current.state.nextRunAtMs)
      : null;

    this.sql.exec(
      `UPDATE schedules
          SET name = ?,
              description = ?,
              enabled = ?,
              expression_json = ?,
              target_json = ?,
              next_run_at = ?,
              updated_at = ?
        WHERE schedule_id = ?`,
      patch.name ?? current.name,
      patch.description === undefined ? current.description ?? null : patch.description,
      enabled ? 1 : 0,
      JSON.stringify(expression),
      JSON.stringify(patch.target ?? current.target),
      nextRunAt,
      patch.now,
      id,
    );

    const record = this.get(id);
    if (!record) {
      throw new Error(`Schedule not found after update: ${id}`);
    }
    return record;
  }

  remove(id: string): StoredScheduleRecord | null {
    const existing = this.getStored(id);
    if (!existing) {
      return null;
    }
    this.sql.exec("DELETE FROM schedules WHERE schedule_id = ?", id);
    return existing;
  }

  setWakeScheduleId(id: string, wakeScheduleId: string | null, now = Date.now()): void {
    this.sql.exec(
      "UPDATE schedules SET wake_schedule_id = ?, updated_at = ? WHERE schedule_id = ?",
      wakeScheduleId,
      now,
      id,
    );
  }

  markRunning(id: string, startedAt: number): ScheduleRecord | null {
    const current = this.getStored(id);
    if (!current) {
      return null;
    }
    if (current.state.runningAtMs !== null) {
      return null;
    }
    this.sql.exec(
      "UPDATE schedules SET running_at = ?, updated_at = ? WHERE schedule_id = ? AND running_at IS NULL",
      startedAt,
      startedAt,
      id,
    );
    return this.get(id);
  }

  /**
   * Finish executions whose owning runtime disappeared before it could commit.
   * The original due time remains in place so re-arming retries the schedule;
   * the stale executor is separately generation-fenced from committing later.
   * Keep the old wake id until recovery replaces it so the persisted Agent
   * one-shot can be cancelled instead of becoming an untracked stale wake.
   */
  releaseInterruptedRuns(
    reason: string,
    finishedAtMs = Date.now(),
    packageOnly = false,
  ): number {
    return this.releaseMatchingInterruptedRuns(reason, finishedAtMs, {
      packageOnly,
    });
  }

  /**
   * Release only executions owned by one account runtime. Master lifecycle
   * recovery uses this path so one user's fence cannot disturb another user's
   * schedules that happen to be running in the same legacy Kernel.
   */
  releaseInterruptedRunsForOwner(
    ownerUid: number,
    reason: string,
    finishedAtMs = Date.now(),
  ): number {
    if (!Number.isSafeInteger(ownerUid) || ownerUid < 0) {
      throw new Error("ownerUid must be a safe non-negative integer");
    }
    return this.releaseMatchingInterruptedRuns(reason, finishedAtMs, { ownerUid });
  }

  private releaseMatchingInterruptedRuns(
    reason: string,
    finishedAtMs: number,
    filter: { ownerUid?: number; packageOnly?: boolean },
  ): number {
    const error = (reason.trim() || "Schedule runtime was interrupted").slice(0, 512);
    const clauses = ["running_at IS NOT NULL"];
    const bindings: unknown[] = [];
    if (filter.ownerUid !== undefined) {
      clauses.push("owner_uid = ?");
      bindings.push(filter.ownerUid);
    }
    if (filter.packageOnly) {
      clauses.push("package_security_revision IS NOT NULL");
    }
    const interrupted = this.sql.exec<InterruptedScheduleRow>(
      `SELECT schedule_id, owner_uid, running_at
       FROM schedules
       WHERE ${clauses.join(" AND ")}
       ORDER BY schedule_id`,
      ...bindings,
    ).toArray();
    let released = 0;

    for (const row of interrupted) {
      const durationMs = Math.max(0, finishedAtMs - row.running_at);
      const updated = this.sql.exec(
        `UPDATE schedules
         SET running_at = NULL,
             last_run_at = ?,
             last_status = 'error',
             last_error = ?,
             last_duration_ms = ?,
             run_count = run_count + 1,
             updated_at = ?
         WHERE schedule_id = ? AND owner_uid = ? AND running_at = ?`,
        finishedAtMs,
        error,
        durationMs,
        finishedAtMs,
        row.schedule_id,
        row.owner_uid,
        row.running_at,
      );
      if (updated.rowsWritten === 0) {
        continue;
      }
      this.sql.exec(
        `INSERT INTO schedule_runs (
          run_id, schedule_id, owner_uid, scheduled_at, started_at, finished_at,
          status, error, result_json
        ) VALUES (?, ?, ?, NULL, ?, ?, 'error', ?, ?)`,
        crypto.randomUUID(),
        row.schedule_id,
        row.owner_uid,
        row.running_at,
        finishedAtMs,
        error,
        JSON.stringify({ interrupted: true, error }),
      );
      released += 1;
    }

    return released;
  }

  finishRun(input: {
    scheduleId: string;
    ownerUid: number;
    scheduledAtMs: number | null;
    startedAtMs: number;
    finishedAtMs: number;
    status: "ok" | "error" | "skipped";
    error?: string;
    result?: unknown;
    nextRunAtMs: number | null;
    enabled: boolean;
  }): ScheduleRecord | null {
    const durationMs = Math.max(0, input.finishedAtMs - input.startedAtMs);
    this.sql.exec(
      `UPDATE schedules
          SET enabled = ?,
              running_at = NULL,
              last_run_at = ?,
              last_status = ?,
              last_error = ?,
              last_duration_ms = ?,
              run_count = run_count + ?,
              next_run_at = ?,
              updated_at = ?
        WHERE schedule_id = ?`,
      input.enabled ? 1 : 0,
      input.finishedAtMs,
      input.status,
      input.error ?? null,
      durationMs,
      input.status === "skipped" ? 0 : 1,
      input.nextRunAtMs,
      input.finishedAtMs,
      input.scheduleId,
    );

    this.sql.exec(
      `INSERT INTO schedule_runs (
        run_id, schedule_id, owner_uid, scheduled_at, started_at, finished_at,
        status, error, result_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      crypto.randomUUID(),
      input.scheduleId,
      input.ownerUid,
      input.scheduledAtMs,
      input.startedAtMs,
      input.finishedAtMs,
      input.status,
      input.error ?? null,
      JSON.stringify(input.result ?? null),
    );

    return this.get(input.scheduleId);
  }

  history(scheduleId: string, limit = 20): ScheduleRunHistoryEntry[] {
    return this.sql.exec<ScheduleRunRow>(
      `SELECT * FROM schedule_runs
       WHERE schedule_id = ?
       ORDER BY started_at DESC
       LIMIT ?`,
      scheduleId,
      clampListLimit(limit),
    ).toArray().map(toHistoryEntry);
  }

  getCronFile(path: string): CronFileRecord | null {
    const rows = this.sql.exec<CronFileRow>(
      "SELECT * FROM cron_files WHERE path = ? LIMIT 1",
      path,
    ).toArray();
    return rows[0] ? toCronFileRecord(rows[0]) : null;
  }

  listCronFiles(args?: {
    prefix?: string;
    ownerUid?: number | null;
  }): CronFileRecord[] {
    const clauses: string[] = [];
    const bindings: unknown[] = [];
    if (args?.prefix) {
      clauses.push("path LIKE ?");
      bindings.push(`${args.prefix}%`);
    }
    if (args && "ownerUid" in args) {
      if (args.ownerUid === null) {
        clauses.push("owner_uid IS NULL");
      } else {
        clauses.push("owner_uid = ?");
        bindings.push(args.ownerUid);
      }
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.sql.exec<CronFileRow>(
      `SELECT * FROM cron_files ${where} ORDER BY path`,
      ...bindings,
    ).toArray().map(toCronFileRecord);
  }

  upsertCronFile(input: {
    path: string;
    ownerUid: number | null;
    content: string;
    now: number;
  }): CronFileRecord {
    const existing = this.getCronFile(input.path);
    this.sql.exec(
      `INSERT OR REPLACE INTO cron_files (path, owner_uid, content, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      input.path,
      input.ownerUid,
      input.content,
      existing?.createdAtMs ?? input.now,
      input.now,
    );
    const record = this.getCronFile(input.path);
    if (!record) {
      throw new Error(`Failed to store cron file ${input.path}`);
    }
    return record;
  }

  removeCronFile(path: string): CronFileRecord | null {
    const existing = this.getCronFile(path);
    if (!existing) {
      return null;
    }
    this.sql.exec("DELETE FROM cron_files WHERE path = ?", path);
    this.clearCronFileScheduleLinks(path);
    return existing;
  }

  linkCronFileSchedule(path: string, scheduleId: string): void {
    this.sql.exec(
      "INSERT OR IGNORE INTO cron_file_schedules (path, schedule_id) VALUES (?, ?)",
      path,
      scheduleId,
    );
  }

  cronFileScheduleIds(path: string): string[] {
    return this.sql.exec<CronFileScheduleRow>(
      "SELECT schedule_id FROM cron_file_schedules WHERE path = ? ORDER BY schedule_id",
      path,
    ).toArray().map((row) => row.schedule_id);
  }

  clearCronFileScheduleLinks(path: string): void {
    this.sql.exec("DELETE FROM cron_file_schedules WHERE path = ?", path);
  }
}

export function handleSchedulerList(
  args: SchedulerListArgs,
  ctx: KernelContext,
): SchedulerListResult {
  const store = ctx.schedules;
  const callerOwnerUid = resolveCallerOwnerUid(ctx);
  const ownerUid = callerOwnerUid === 0 ? args.ownerUid : callerOwnerUid;
  assertLocalUserKernelUid(ctx, ownerUid, "schedule listing");
  const listed = store.list({
    ownerUid,
    includeDisabled: args.includeDisabled,
    limit: args.limit,
    offset: args.offset,
  });
  return { schedules: listed.records, count: listed.count };
}

export async function handleSchedulerAdd(
  args: SchedulerAddArgs,
  ctx: KernelContext,
): Promise<SchedulerAddResult> {
  const store = ctx.schedules;
  const now = Date.now();
  const expression = normalizeScheduleExpression(args.expression, ctx);
  assertSchedulableAtExpression(expression, args.enabled !== false, now);
  const target = normalizeScheduleTarget(args.target);
  validateScheduleTargetAccess(target, ctx);

  const principal = principalFromContext(ctx);
  const ownerUid = resolveCallerOwnerUid(ctx);
  const packageSecurityRevision = packageAgentRuntimeSecurityRevision(
    ctx,
    ctx.identity!.process.uid,
  );
  const schedule = store.create({
    ownerUid,
    creator: principal,
    runAs: principal,
    ...(packageSecurityRevision ? { packageSecurityRevision } : {}),
    name: normalizeRequiredText(args.name, "schedule name"),
    description: normalizeOptionalText(args.description),
    enabled: args.enabled !== false,
    expression,
    target,
    now,
  });

  await armSchedule(ctx, schedule);
  return { schedule };
}

export async function handleSchedulerUpdate(
  args: SchedulerUpdateArgs,
  ctx: KernelContext,
): Promise<SchedulerUpdateResult> {
  const store = ctx.schedules;
  const existing = store.getStored(normalizeRequiredText(args.id, "schedule id"));
  if (!existing) {
    throw new Error(`Schedule not found: ${args.id}`);
  }
  assertCanManageSchedule(ctx.identity!, existing, resolveCallerOwnerUid(ctx));

  const nextTarget = args.patch.target === undefined
    ? existing.target
    : normalizeScheduleTarget(args.patch.target);
  validateScheduleTargetAccess(nextTarget, ctx);

  const now = Date.now();
  const nextExpression = args.patch.expression === undefined
    ? existing.expression
    : normalizeScheduleExpression(args.patch.expression, ctx);
  const nextEnabled = args.patch.enabled ?? existing.enabled;
  if (args.patch.expression !== undefined || args.patch.enabled === true) {
    assertSchedulableAtExpression(nextExpression, nextEnabled, now);
  }

  const patch = {
    name: args.patch.name === undefined
      ? undefined
      : normalizeRequiredText(args.patch.name, "schedule name"),
    description: args.patch.description === undefined
      ? undefined
      : normalizeOptionalText(args.patch.description ?? undefined) ?? null,
    enabled: args.patch.enabled,
    expression: args.patch.expression === undefined ? undefined : nextExpression,
    target: nextTarget,
    now,
  };

  const previousWakeId = existing.wakeScheduleId;
  if (previousWakeId) {
    await ctx.cancelScheduleWake(previousWakeId);
  }

  const schedule = store.update(existing.id, patch);

  await armSchedule(ctx, schedule);
  return { schedule };
}

export async function handleSchedulerRemove(
  args: SchedulerRemoveArgs,
  ctx: KernelContext,
): Promise<SchedulerRemoveResult> {
  const store = ctx.schedules;
  const existing = store.getStored(normalizeRequiredText(args.id, "schedule id"));
  if (!existing) {
    return { removed: false };
  }
  assertCanManageSchedule(ctx.identity!, existing, resolveCallerOwnerUid(ctx));
  const removed = store.remove(existing.id);
  if (removed?.wakeScheduleId) {
    await ctx.cancelScheduleWake(removed.wakeScheduleId);
  }
  return { removed: true };
}

export async function handleSchedulerRun(
  args: SchedulerRunArgs,
  ctx: KernelContext,
): Promise<SchedulerRunResult> {
  return ctx.runSchedules(args, ctx.identity!, resolveCallerOwnerUid(ctx));
}

export function normalizeScheduleExpression(
  expression: ScheduleExpression,
  ctx?: KernelContext,
): ScheduleExpression {
  if (!expression || typeof expression !== "object") {
    throw new Error("schedule expression must be an object");
  }

  if (expression.kind === "at") {
    return { kind: "at", atMs: normalizeTimestamp(expression.atMs, "schedule atMs") };
  }
  if (expression.kind === "after") {
    return { kind: "after", afterMs: normalizePositiveInteger(expression.afterMs, "schedule afterMs") };
  }
  if (expression.kind === "every") {
    const everyMs = normalizePositiveInteger(expression.everyMs, "schedule everyMs");
    if (everyMs < MIN_INTERVAL_MS) {
      throw new Error(`schedule everyMs must be at least ${MIN_INTERVAL_MS}`);
    }
    return {
      kind: "every",
      everyMs,
      ...(expression.anchorMs === undefined
        ? {}
        : { anchorMs: normalizeTimestamp(expression.anchorMs, "schedule anchorMs") }),
    };
  }
  if (expression.kind === "cron") {
    const expr = normalizeRequiredText(expression.expr, "cron expression");
    parseCronFields(expr);
    const timezone = normalizeTimezone(expression.timezone || ctx?.config.get("config/server/timezone") || "UTC");
    return { kind: "cron", expr, timezone };
  }
  throw new Error(`unsupported schedule expression kind: ${(expression as { kind?: unknown }).kind}`);
}

export function computeNextRunAt(expression: ScheduleExpression, afterMs: number): number | null {
  switch (expression.kind) {
    case "at":
      return expression.atMs > afterMs ? expression.atMs : null;
    case "after":
      return afterMs + expression.afterMs;
    case "every":
      return computeEveryNextRunAt(expression, afterMs);
    case "cron":
      return computeCronNextRunAt(expression, afterMs);
  }
}

function assertSchedulableAtExpression(
  expression: ScheduleExpression,
  enabled: boolean,
  now: number,
): void {
  if (enabled && expression.kind === "at" && expression.atMs <= now) {
    throw new Error("schedule atMs must be in the future");
  }
}

export function computeNextRunAfterFinish(
  expression: ScheduleExpression,
  finishedAtMs: number,
): { enabled: boolean; nextRunAtMs: number | null } {
  if (expression.kind === "at" || expression.kind === "after") {
    return { enabled: false, nextRunAtMs: null };
  }
  return { enabled: true, nextRunAtMs: computeNextRunAt(expression, finishedAtMs) };
}

export function assertCanManageSchedule(
  identity: ConnectionIdentity,
  record: ScheduleRecord,
  callerOwnerUid = identity.process.uid,
): void {
  if (callerOwnerUid === 0 || callerOwnerUid === record.ownerUid) {
    return;
  }
  throw new Error(`Permission denied: cannot access schedule ${record.id}`);
}

export async function armSchedule(ctx: KernelContext, record: ScheduleRecord): Promise<void> {
  const store = ctx.schedules;
  if (!record.enabled || record.state.nextRunAtMs === null) {
    store.setWakeScheduleId(record.id, null);
    return;
  }
  const wakeId = await ctx.scheduleScheduleWake(record.id, record.state.nextRunAtMs);
  store.setWakeScheduleId(record.id, wakeId);
}

function principalFromContext(ctx: KernelContext): SchedulePrincipal {
  const identity = ctx.identity!;
  if (ctx.processId) {
    return {
      kind: "process",
      uid: identity.process.uid,
      username: identity.process.username,
      pid: ctx.processId,
    };
  }
  if (identity.role === "service") {
    return {
      kind: "service",
      uid: identity.process.uid,
      username: identity.process.username,
      channel: identity.channel,
    };
  }
  return {
    kind: "user",
    uid: identity.process.uid,
    username: identity.process.username,
  };
}

function normalizeScheduleTarget(target: ScheduleTarget): ScheduleTarget {
  if (!target || typeof target !== "object") {
    throw new Error("schedule target must be an object");
  }

  if (target.kind === "command.exec") {
    return {
      kind: "command.exec",
      command: normalizeRequiredText(target.command, "command.exec command"),
      ...(target.cwd ? { cwd: normalizeRequiredText(target.cwd, "command.exec cwd") } : {}),
      ...(target.timeoutMs === undefined
        ? {}
        : { timeoutMs: normalizePositiveInteger(target.timeoutMs, "command.exec timeoutMs") }),
    };
  }

  if (target.kind === "process.spawn") {
    const prompt = normalizeRequiredText(target.prompt, "process.spawn prompt");
    return {
      kind: "process.spawn",
      prompt,
      ...(target.runAs ? { runAs: normalizeRequiredText(target.runAs, "process.spawn runAs") } : {}),
      ...(target.label ? { label: normalizeRequiredText(target.label, "process.spawn label") } : {}),
      ...(target.parentPid ? { parentPid: normalizeRequiredText(target.parentPid, "process.spawn parentPid") } : {}),
      ...(target.cwd ? { cwd: normalizeRequiredText(target.cwd, "process.spawn cwd") } : {}),
      ...(target.assignment ? { assignment: target.assignment } : {}),
    };
  }

  if (target.kind === "process.event") {
    return {
      kind: "process.event",
      pid: normalizeRequiredText(target.pid, "process.event pid"),
      message: normalizeRequiredText(target.message, "process.event message"),
      ...(target.conversationId
        ? { conversationId: normalizeRequiredText(target.conversationId, "process.event conversationId") }
        : {}),
      ...(target.data === undefined ? {} : { data: normalizePlainObject(target.data, "process.event data") }),
    };
  }

  throw new Error(`unsupported schedule target kind: ${(target as { kind?: unknown }).kind}`);
}

function validateScheduleTargetAccess(target: ScheduleTarget, ctx: KernelContext): void {
  const ownerUid = resolveCallerOwnerUid(ctx);
  if (target.kind === "command.exec" && !hasCapability(ctx.identity?.capabilities ?? [], "shell.exec")) {
    throw new Error("Permission denied: shell.exec");
  }
  if (target.kind === "process.spawn" && !hasCapability(ctx.identity?.capabilities ?? [], "proc.spawn")) {
    throw new Error("Permission denied: proc.spawn");
  }
  if (target.kind === "process.event") {
    if (!hasCapability(ctx.identity?.capabilities ?? [], "proc.send")) {
      throw new Error("Permission denied: proc.send");
    }
    const proc = ctx.procs.get(target.pid);
    if (!proc) {
      throw new Error(`Process not found: ${target.pid}`);
    }
    if (ownerUid !== 0 && proc.ownerUid !== ownerUid) {
      throw new Error(`Permission denied: cannot schedule process ${target.pid}`);
    }
  }
  if (target.kind === "process.spawn" && target.parentPid) {
    const parent = ctx.procs.get(target.parentPid);
    if (!parent) {
      throw new Error(`Process not found: ${target.parentPid}`);
    }
    if (ownerUid !== 0 && parent.ownerUid !== ownerUid) {
      throw new Error(`Permission denied: cannot schedule child under ${target.parentPid}`);
    }
  }
}

function computeEveryNextRunAt(
  expression: Extract<ScheduleExpression, { kind: "every" }>,
  afterMs: number,
): number {
  const anchor = expression.anchorMs ?? afterMs;
  if (afterMs < anchor) {
    return anchor;
  }
  const steps = Math.floor((afterMs - anchor) / expression.everyMs) + 1;
  return anchor + (steps * expression.everyMs);
}

function computeCronNextRunAt(
  expression: Extract<ScheduleExpression, { kind: "cron" }>,
  afterMs: number,
): number {
  const fields = parseCronFields(expression.expr);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: expression.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  let candidate = Math.floor(afterMs / 60_000) * 60_000 + 60_000;
  for (let scanned = 0; scanned < MAX_CRON_SCAN_MINUTES; scanned += 1) {
    const local = zonedDateParts(candidate, formatter);
    if (cronFieldsMatch(fields, local)) {
      return candidate;
    }
    candidate += 60_000;
  }
  throw new Error(`cron expression has no next run within ${MAX_CRON_SCAN_MINUTES} minutes`);
}

type CronFields = {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  anyDayOfMonth: boolean;
  anyDayOfWeek: boolean;
};

type ZonedDateParts = {
  minute: number;
  hour: number;
  dayOfMonth: number;
  month: number;
  dayOfWeek: number;
};

function parseCronFields(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error("cron expression must use five fields: minute hour day-of-month month day-of-week");
  }

  const dayOfMonth = parseCronField(parts[2], 1, 31, "day-of-month");
  const dayOfWeek = parseCronField(parts[4], 0, 7, "day-of-week");
  return {
    minute: parseCronField(parts[0], 0, 59, "minute"),
    hour: parseCronField(parts[1], 0, 23, "hour"),
    dayOfMonth,
    month: parseCronField(parts[3], 1, 12, "month"),
    dayOfWeek: normalizeDayOfWeek(dayOfWeek),
    anyDayOfMonth: isFullCronRange(dayOfMonth, 1, 31),
    anyDayOfWeek: isFullCronRange(normalizeDayOfWeek(dayOfWeek), 0, 6),
  };
}

function parseCronField(value: string, min: number, max: number, label: string): Set<number> {
  const out = new Set<number>();
  for (const rawPart of value.split(",")) {
    const part = rawPart.trim();
    if (!part) {
      throw new Error(`cron ${label} contains an empty list item`);
    }
    const [rangePart, stepPart] = part.split("/");
    if (part.split("/").length > 2) {
      throw new Error(`cron ${label} has invalid step syntax`);
    }
    const step = stepPart === undefined ? 1 : parsePositiveStep(stepPart, label);
    const [start, end] = parseCronRange(rangePart, min, max, label);
    for (let current = start; current <= end; current += step) {
      out.add(current);
    }
  }
  if (out.size === 0) {
    throw new Error(`cron ${label} has no values`);
  }
  return out;
}

function parseCronRange(value: string, min: number, max: number, label: string): [number, number] {
  if (value === "*") {
    return [min, max];
  }
  const pieces = value.split("-");
  if (pieces.length === 1) {
    const n = parseCronNumber(pieces[0], min, max, label);
    return [n, n];
  }
  if (pieces.length === 2) {
    const start = parseCronNumber(pieces[0], min, max, label);
    const end = parseCronNumber(pieces[1], min, max, label);
    if (start > end) {
      throw new Error(`cron ${label} range starts after it ends`);
    }
    return [start, end];
  }
  throw new Error(`cron ${label} range is invalid`);
}

function parseCronNumber(value: string, min: number, max: number, label: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`cron ${label} must be numeric`);
  }
  const n = Number.parseInt(value, 10);
  if (n < min || n > max) {
    throw new Error(`cron ${label} value ${n} is outside ${min}-${max}`);
  }
  return n;
}

function parsePositiveStep(value: string, label: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`cron ${label} step must be numeric`);
  }
  const step = Number.parseInt(value, 10);
  if (step <= 0) {
    throw new Error(`cron ${label} step must be positive`);
  }
  return step;
}

function normalizeDayOfWeek(values: Set<number>): Set<number> {
  const out = new Set<number>();
  for (const value of values) {
    out.add(value === 7 ? 0 : value);
  }
  return out;
}

function isFullCronRange(values: Set<number>, min: number, max: number): boolean {
  if (values.size !== max - min + 1) {
    return false;
  }
  for (let value = min; value <= max; value += 1) {
    if (!values.has(value)) {
      return false;
    }
  }
  return true;
}

function cronFieldsMatch(fields: CronFields, local: ZonedDateParts): boolean {
  if (!fields.minute.has(local.minute) || !fields.hour.has(local.hour) || !fields.month.has(local.month)) {
    return false;
  }

  const domMatches = fields.dayOfMonth.has(local.dayOfMonth);
  const dowMatches = fields.dayOfWeek.has(local.dayOfWeek);
  const dayMatches = fields.anyDayOfMonth && fields.anyDayOfWeek
    ? true
    : fields.anyDayOfMonth
      ? dowMatches
      : fields.anyDayOfWeek
        ? domMatches
        : domMatches || dowMatches;

  return dayMatches;
}

function zonedDateParts(ms: number, formatter: Intl.DateTimeFormat): ZonedDateParts {
  const parts = formatter.formatToParts(new Date(ms));
  const value = (type: string) => {
    const part = parts.find((entry) => entry.type === type)?.value;
    return part === undefined ? NaN : Number.parseInt(part, 10);
  };
  const year = value("year");
  const month = value("month");
  const dayOfMonth = value("day");
  return {
    month,
    dayOfMonth,
    hour: value("hour"),
    minute: value("minute"),
    dayOfWeek: new Date(Date.UTC(year, month - 1, dayOfMonth)).getUTCDay(),
  };
}

function normalizeTimestamp(value: unknown, label: string): number {
  const n = normalizePositiveInteger(value, label);
  if (n < 0) {
    throw new Error(`${label} must be non-negative`);
  }
  return n;
}

function normalizePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function normalizeRequiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function normalizeOptionalText(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error("description must be a string");
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizePlainObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function normalizeTimezone(value: unknown): string {
  const timezone = normalizeRequiredText(value, "timezone");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
  } catch {
    throw new Error("timezone must be a valid IANA timezone");
  }
  return timezone;
}

function clampListLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_LIST_LIMIT;
  }
  return Math.max(1, Math.min(MAX_LIST_LIMIT, Math.trunc(value)));
}

function toRecord(row: ScheduleRow): StoredScheduleRecord {
  return {
    id: row.schedule_id,
    ownerUid: row.owner_uid,
    creator: parseJson<SchedulePrincipal>(row.creator_json),
    runAs: parseJson<SchedulePrincipal>(row.run_as_json),
    packageSecurityRevision: row.package_security_revision ?? null,
    name: row.name,
    ...(row.description ? { description: row.description } : {}),
    enabled: row.enabled === 1,
    expression: normalizeScheduleExpression(parseJson<ScheduleExpression>(row.expression_json)),
    target: normalizeScheduleTarget(parseJson<ScheduleTarget>(row.target_json)),
    overlapPolicy: "skip",
    createdAtMs: row.created_at,
    updatedAtMs: row.updated_at,
    state: {
      nextRunAtMs: row.next_run_at,
      runningAtMs: row.running_at,
      lastRunAtMs: row.last_run_at,
      lastStatus: row.last_status as ScheduleRecord["state"]["lastStatus"],
      lastError: row.last_error,
      lastDurationMs: row.last_duration_ms,
      runCount: row.run_count,
    },
    wakeScheduleId: row.wake_schedule_id,
  };
}

function publicRecord(record: StoredScheduleRecord): ScheduleRecord {
  return {
    id: record.id,
    ownerUid: record.ownerUid,
    creator: record.creator,
    runAs: record.runAs,
    name: record.name,
    ...(record.description ? { description: record.description } : {}),
    enabled: record.enabled,
    expression: record.expression,
    target: record.target,
    overlapPolicy: record.overlapPolicy,
    createdAtMs: record.createdAtMs,
    updatedAtMs: record.updatedAtMs,
    state: record.state,
  };
}

function toHistoryEntry(row: ScheduleRunRow): ScheduleRunHistoryEntry {
  const result = parseJson<unknown>(row.result_json);
  return {
    id: row.run_id,
    scheduleId: row.schedule_id,
    scheduledAtMs: row.scheduled_at,
    startedAtMs: row.started_at,
    finishedAtMs: row.finished_at,
    status: row.status as ScheduleRunHistoryEntry["status"],
    ...(row.error ? { error: row.error } : {}),
    ...(result === null ? {} : { result }),
  };
}

function toCronFileRecord(row: CronFileRow): CronFileRecord {
  return {
    path: row.path,
    ownerUid: row.owner_uid,
    content: row.content,
    createdAtMs: row.created_at,
    updatedAtMs: row.updated_at,
  };
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

export function skippedScheduleResult(
  scheduleId: string,
  reason: string,
  durationMs = 0,
): ScheduleRunResult {
  return {
    scheduleId,
    status: "skipped",
    error: reason,
    durationMs,
  };
}
