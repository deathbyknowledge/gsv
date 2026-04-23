export type AppRpcSchedule =
  | { kind: "at"; atMs: number }
  | { kind: "after"; afterMs: number }
  | { kind: "every"; everyMs: number; anchorMs?: number };

export type AppRpcScheduleStatus = "ok" | "error";

export type AppRpcScheduleRecord = {
  key: string;
  rpcMethod: string;
  schedule: AppRpcSchedule;
  payload?: unknown;
  enabled: boolean;
  version: number;
  createdAt: number;
  updatedAt: number;
  nextRunAt: number | null;
  runningAt: number | null;
  lastRunAt: number | null;
  lastStatus: AppRpcScheduleStatus | null;
  lastError: string | null;
  lastDurationMs: number | null;
};

export type AppRpcScheduleUpsertInput = {
  key: string;
  rpcMethod: string;
  schedule: AppRpcSchedule;
  payload?: unknown;
  enabled?: boolean;
};

type AppRpcScheduleRow = {
  schedule_key: string;
  rpc_method: string;
  schedule_json: string;
  payload_json: string | null;
  enabled: number;
  version: number;
  created_at: number;
  updated_at: number;
  next_run_at: number | null;
  running_at: number | null;
  last_run_at: number | null;
  last_status: string | null;
  last_error: string | null;
  last_duration_ms: number | null;
};

export function normalizeAppRpcSchedule(schedule: AppRpcSchedule): AppRpcSchedule {
  if (!schedule || typeof schedule !== "object") {
    throw new Error("daemon schedule must be an object");
  }
  if (schedule.kind === "at") {
    const atMs = normalizePositiveInteger(schedule.atMs, "daemon schedule atMs");
    return { kind: "at", atMs };
  }
  if (schedule.kind === "after") {
    const afterMs = normalizePositiveInteger(schedule.afterMs, "daemon schedule afterMs");
    return { kind: "after", afterMs };
  }
  if (schedule.kind === "every") {
    const everyMs = normalizePositiveInteger(schedule.everyMs, "daemon schedule everyMs");
    const anchorMs = schedule.anchorMs === undefined
      ? undefined
      : normalizeInteger(schedule.anchorMs, "daemon schedule anchorMs");
    return anchorMs === undefined
      ? { kind: "every", everyMs }
      : { kind: "every", everyMs, anchorMs };
  }
  throw new Error(`unsupported daemon schedule kind: ${(schedule as { kind?: unknown }).kind}`);
}

export function computeInitialNextRunAt(schedule: AppRpcSchedule, now: number): number {
  switch (schedule.kind) {
    case "at":
      return schedule.atMs;
    case "after":
      return now + schedule.afterMs;
    case "every":
      return computeRecurringNextRunAt(schedule, now);
  }
}

export function computeRecurringNextRunAt(
  schedule: Extract<AppRpcSchedule, { kind: "every" }>,
  now: number,
): number {
  const anchor = schedule.anchorMs ?? now;
  if (now < anchor) {
    return anchor;
  }
  const elapsed = now - anchor;
  const steps = Math.floor(elapsed / schedule.everyMs) + 1;
  return anchor + (steps * schedule.everyMs);
}

export class AppRpcScheduleStore {
  constructor(private readonly sql: SqlStorage) {}

  init(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS app_rpc_schedules (
        schedule_key     TEXT PRIMARY KEY,
        rpc_method       TEXT NOT NULL,
        schedule_json    TEXT NOT NULL,
        payload_json     TEXT,
        enabled          INTEGER NOT NULL DEFAULT 1,
        version          INTEGER NOT NULL DEFAULT 1,
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL,
        next_run_at      INTEGER,
        running_at       INTEGER,
        last_run_at      INTEGER,
        last_status      TEXT,
        last_error       TEXT,
        last_duration_ms INTEGER
      )
    `);
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_app_rpc_schedules_due ON app_rpc_schedules (enabled, next_run_at, schedule_key)",
    );
  }

  get(key: string): AppRpcScheduleRecord | null {
    const normalizedKey = normalizeKey(key);
    const rows = this.sql.exec<AppRpcScheduleRow>(
      "SELECT * FROM app_rpc_schedules WHERE schedule_key = ?",
      normalizedKey,
    ).toArray();
    return rows[0] ? rowToRecord(rows[0]) : null;
  }

  list(): AppRpcScheduleRecord[] {
    const rows = this.sql.exec<AppRpcScheduleRow>(
      "SELECT * FROM app_rpc_schedules ORDER BY CASE WHEN next_run_at IS NULL THEN 1 ELSE 0 END, next_run_at ASC, schedule_key ASC",
    ).toArray();
    return rows.map(rowToRecord);
  }

  upsert(input: AppRpcScheduleUpsertInput, now: number = Date.now()): AppRpcScheduleRecord {
    const key = normalizeKey(input.key);
    const rpcMethod = normalizeRpcMethod(input.rpcMethod);
    const schedule = normalizeAppRpcSchedule(input.schedule);
    const existing = this.get(key);
    const enabled = input.enabled ?? existing?.enabled ?? true;
    const record: AppRpcScheduleRecord = {
      key,
      rpcMethod,
      schedule,
      payload: input.payload,
      enabled,
      version: (existing?.version ?? 0) + 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      nextRunAt: enabled ? computeInitialNextRunAt(schedule, now) : null,
      runningAt: null,
      lastRunAt: existing?.lastRunAt ?? null,
      lastStatus: existing?.lastStatus ?? null,
      lastError: existing?.lastError ?? null,
      lastDurationMs: existing?.lastDurationMs ?? null,
    };
    this.#write(record);
    return record;
  }

  remove(key: string): boolean {
    const normalizedKey = normalizeKey(key);
    if (!this.get(normalizedKey)) {
      return false;
    }
    this.sql.exec("DELETE FROM app_rpc_schedules WHERE schedule_key = ?", normalizedKey);
    return true;
  }

  due(now: number = Date.now()): AppRpcScheduleRecord[] {
    const rows = this.sql.exec<AppRpcScheduleRow>(
      "SELECT * FROM app_rpc_schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC, schedule_key ASC",
      now,
    ).toArray();
    return rows.map(rowToRecord);
  }

  nextAlarmAt(): number | null {
    const rows = this.sql.exec<{ next_run_at: number | null }>(
      "SELECT next_run_at FROM app_rpc_schedules WHERE enabled = 1 AND next_run_at IS NOT NULL ORDER BY next_run_at ASC LIMIT 1",
    ).toArray();
    const value = rows[0]?.next_run_at;
    return typeof value === "number" ? value : null;
  }

  markRunning(key: string, version: number, runningAt: number): AppRpcScheduleRecord | null {
    const current = this.get(key);
    if (!current || current.version !== version) {
      return null;
    }
    const updated: AppRpcScheduleRecord = {
      ...current,
      updatedAt: runningAt,
      runningAt,
      nextRunAt: null,
    };
    this.#write(updated);
    return updated;
  }

  finishRun(args: {
    key: string;
    version: number;
    finishedAt: number;
    status: AppRpcScheduleStatus;
    error?: string | null;
    durationMs: number;
  }): AppRpcScheduleRecord | null {
    const current = this.get(args.key);
    if (!current) {
      return null;
    }
    if (current.version !== args.version) {
      const preserved: AppRpcScheduleRecord = {
        ...current,
        updatedAt: Math.max(current.updatedAt, args.finishedAt),
        runningAt: null,
        lastRunAt: args.finishedAt,
        lastStatus: args.status,
        lastError: args.error ?? null,
        lastDurationMs: args.durationMs,
      };
      this.#write(preserved);
      return preserved;
    }

    const schedule = current.schedule;
    const repeating = schedule.kind === "every";
    const nextRunAt = current.enabled && repeating
      ? computeRecurringNextRunAt(schedule, args.finishedAt)
      : null;
    const completed: AppRpcScheduleRecord = {
      ...current,
      enabled: repeating ? current.enabled : false,
      updatedAt: args.finishedAt,
      nextRunAt,
      runningAt: null,
      lastRunAt: args.finishedAt,
      lastStatus: args.status,
      lastError: args.error ?? null,
      lastDurationMs: args.durationMs,
    };
    this.#write(completed);
    return completed;
  }

  #write(record: AppRpcScheduleRecord): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO app_rpc_schedules (
        schedule_key,
        rpc_method,
        schedule_json,
        payload_json,
        enabled,
        version,
        created_at,
        updated_at,
        next_run_at,
        running_at,
        last_run_at,
        last_status,
        last_error,
        last_duration_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.key,
      record.rpcMethod,
      JSON.stringify(record.schedule),
      record.payload === undefined ? null : JSON.stringify(record.payload),
      record.enabled ? 1 : 0,
      record.version,
      record.createdAt,
      record.updatedAt,
      record.nextRunAt,
      record.runningAt,
      record.lastRunAt,
      record.lastStatus,
      record.lastError,
      record.lastDurationMs,
    );
  }
}

function rowToRecord(row: AppRpcScheduleRow): AppRpcScheduleRecord {
  return {
    key: row.schedule_key,
    rpcMethod: row.rpc_method,
    schedule: normalizeAppRpcSchedule(JSON.parse(row.schedule_json) as AppRpcSchedule),
    payload: row.payload_json ? JSON.parse(row.payload_json) : undefined,
    enabled: row.enabled !== 0,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    nextRunAt: row.next_run_at,
    runningAt: row.running_at,
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status === "ok" || row.last_status === "error"
      ? row.last_status
      : null,
    lastError: row.last_error,
    lastDurationMs: row.last_duration_ms,
  };
}

function normalizeKey(value: string): string {
  const key = typeof value === "string" ? value.trim() : "";
  if (!key) {
    throw new Error("daemon schedule key is required");
  }
  return key;
}

function normalizeRpcMethod(value: string): string {
  const method = typeof value === "string" ? value.trim() : "";
  if (!method) {
    throw new Error("daemon schedule rpcMethod is required");
  }
  return method;
}

function normalizePositiveInteger(value: number, label: string): number {
  const normalized = normalizeInteger(value, label);
  if (normalized <= 0) {
    throw new Error(`${label} must be greater than zero`);
  }
  return normalized;
}

function normalizeInteger(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return Math.trunc(value);
}
