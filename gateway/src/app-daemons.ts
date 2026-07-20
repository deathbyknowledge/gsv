export type AppRpcSchedule =
  | { kind: "at"; atMs: number }
  | { kind: "after"; afterMs: number }
  | { kind: "every"; everyMs: number; anchorMs?: number };

export type AppRpcScheduleStatus = "ok" | "error";

export type AppRpcScheduleAuthority = {
  key: string;
  ownerUid: number;
  ownerUsername: string;
  kernelUsername: string;
  kernelGeneration: number;
  packageId: string;
  packageName: string;
  packageUpdatedAt: number;
  artifactHash: string;
  entrypointName: string;
  routeBase: string;
  runtime: unknown;
};

export type AppRpcScheduleRecord = {
  key: string;
  authority: AppRpcScheduleAuthority | null;
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
  logical_key: string | null;
  authority_key: string | null;
  owner_uid: number | null;
  owner_username: string | null;
  kernel_username: string | null;
  kernel_generation: number | null;
  package_id: string | null;
  package_name: string | null;
  package_updated_at: number | null;
  artifact_hash: string | null;
  entrypoint_name: string | null;
  route_base: string | null;
  runtime_authority_json: string | null;
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

  get(authority: AppRpcScheduleAuthority, key: string): AppRpcScheduleRecord | null {
    const normalizedAuthority = normalizeAuthority(authority);
    const normalizedKey = normalizeKey(key);
    const rows = this.sql.exec<AppRpcScheduleRow>(
      "SELECT * FROM app_rpc_schedules WHERE schedule_key = ? AND authority_key = ?",
      physicalScheduleKey(normalizedAuthority.key, normalizedKey),
      normalizedAuthority.key,
    ).toArray();
    return rows[0] ? rowToRecord(rows[0]) : null;
  }

  list(authority: AppRpcScheduleAuthority): AppRpcScheduleRecord[] {
    const normalizedAuthority = normalizeAuthority(authority);
    const rows = this.sql.exec<AppRpcScheduleRow>(
      `SELECT * FROM app_rpc_schedules
       WHERE authority_key = ?
       ORDER BY CASE WHEN next_run_at IS NULL THEN 1 ELSE 0 END, next_run_at ASC, logical_key ASC`,
      normalizedAuthority.key,
    ).toArray();
    return rows.map(rowToRecord);
  }

  upsert(
    authority: AppRpcScheduleAuthority,
    input: AppRpcScheduleUpsertInput,
    now: number = Date.now(),
  ): AppRpcScheduleRecord {
    const normalizedAuthority = normalizeAuthority(authority);
    const key = normalizeKey(input.key);
    const rpcMethod = normalizeRpcMethod(input.rpcMethod);
    const schedule = normalizeAppRpcSchedule(input.schedule);
    const existing = this.get(normalizedAuthority, key);
    const enabled = input.enabled ?? existing?.enabled ?? true;
    const record: AppRpcScheduleRecord = {
      key,
      authority: normalizedAuthority,
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

  remove(authority: AppRpcScheduleAuthority, key: string): boolean {
    const normalizedAuthority = normalizeAuthority(authority);
    const normalizedKey = normalizeKey(key);
    if (!this.get(normalizedAuthority, normalizedKey)) {
      return false;
    }
    this.sql.exec(
      "DELETE FROM app_rpc_schedules WHERE schedule_key = ? AND authority_key = ?",
      physicalScheduleKey(normalizedAuthority.key, normalizedKey),
      normalizedAuthority.key,
    );
    return true;
  }

  due(now: number = Date.now()): AppRpcScheduleRecord[] {
    const rows = this.sql.exec<AppRpcScheduleRow>(
      `SELECT * FROM app_rpc_schedules
       WHERE authority_key IS NOT NULL
         AND runtime_authority_json IS NOT NULL
         AND enabled = 1
         AND next_run_at IS NOT NULL
         AND next_run_at <= ?
       ORDER BY next_run_at ASC, schedule_key ASC`,
      now,
    ).toArray();
    return rows.map(rowToRecord);
  }

  nextAlarmAt(): number | null {
    const rows = this.sql.exec<{ next_run_at: number | null }>(
      `SELECT next_run_at FROM app_rpc_schedules
       WHERE authority_key IS NOT NULL
         AND runtime_authority_json IS NOT NULL
         AND enabled = 1
         AND next_run_at IS NOT NULL
       ORDER BY next_run_at ASC LIMIT 1`,
    ).toArray();
    const value = rows[0]?.next_run_at;
    return typeof value === "number" ? value : null;
  }

  markRunning(
    authority: AppRpcScheduleAuthority,
    key: string,
    version: number,
    runningAt: number,
  ): AppRpcScheduleRecord | null {
    const current = this.get(authority, key);
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
    authority: AppRpcScheduleAuthority;
    key: string;
    version: number;
    finishedAt: number;
    status: AppRpcScheduleStatus;
    error?: string | null;
    durationMs: number;
    disable?: boolean;
  }): AppRpcScheduleRecord | null {
    const current = this.get(args.authority, args.key);
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
    const nextRunAt = current.enabled && repeating && !args.disable
      ? computeRecurringNextRunAt(schedule, args.finishedAt)
      : null;
    const completed: AppRpcScheduleRecord = {
      ...current,
      enabled: args.disable ? false : repeating ? current.enabled : false,
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

  interruptRunning(reason: string, now: number = Date.now()): number {
    const normalizedReason = typeof reason === "string" ? reason.trim() : "";
    if (!normalizedReason) {
      throw new Error("daemon interruption reason is required");
    }
    if (!Number.isSafeInteger(now) || now <= 0) {
      throw new Error("daemon interruption timestamp is invalid");
    }
    const running = this.sql.exec<AppRpcScheduleRow>(
      "SELECT * FROM app_rpc_schedules WHERE running_at IS NOT NULL",
    ).toArray().map(rowToRecord);
    for (const record of running) {
      if (!record.authority || record.runningAt === null) {
        continue;
      }
      this.#write({
        ...record,
        enabled: false,
        updatedAt: now,
        nextRunAt: null,
        runningAt: null,
        lastRunAt: now,
        lastStatus: "error",
        lastError: normalizedReason,
        lastDurationMs: Math.max(0, now - record.runningAt),
      });
    }
    return running.filter((record) => record.authority && record.runningAt !== null).length;
  }

  #write(record: AppRpcScheduleRecord): void {
    if (!record.authority) {
      throw new Error("daemon schedule authority is required");
    }
    const authority = normalizeAuthority(record.authority);
    this.sql.exec(
      `INSERT OR REPLACE INTO app_rpc_schedules (
        schedule_key,
        logical_key,
        authority_key,
        owner_uid,
        owner_username,
        kernel_username,
        kernel_generation,
        package_id,
        package_name,
        package_updated_at,
        artifact_hash,
        entrypoint_name,
        route_base,
        runtime_authority_json,
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      physicalScheduleKey(authority.key, record.key),
      record.key,
      authority.key,
      authority.ownerUid,
      authority.ownerUsername,
      authority.kernelUsername,
      authority.kernelGeneration,
      authority.packageId,
      authority.packageName,
      authority.packageUpdatedAt,
      authority.artifactHash,
      authority.entrypointName,
      authority.routeBase,
      JSON.stringify(authority.runtime),
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
    key: row.logical_key ?? row.schedule_key,
    authority: rowAuthority(row),
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

function rowAuthority(row: AppRpcScheduleRow): AppRpcScheduleAuthority | null {
  if (
    !row.authority_key
    || !Number.isSafeInteger(row.owner_uid)
    || row.owner_uid === null
    || row.owner_uid < 0
    || !row.owner_username
    || !row.kernel_username
    || !Number.isSafeInteger(row.kernel_generation)
    || row.kernel_generation === null
    || row.kernel_generation <= 0
    || !row.package_id
    || !row.package_name
    || !Number.isSafeInteger(row.package_updated_at)
    || row.package_updated_at === null
    || row.package_updated_at <= 0
    || !row.artifact_hash
    || !row.entrypoint_name
    || !row.route_base
    || !row.runtime_authority_json
  ) {
    return null;
  }
  try {
    return normalizeAuthority({
      key: row.authority_key,
      ownerUid: row.owner_uid,
      ownerUsername: row.owner_username,
      kernelUsername: row.kernel_username,
      kernelGeneration: row.kernel_generation,
      packageId: row.package_id,
      packageName: row.package_name,
      packageUpdatedAt: row.package_updated_at,
      artifactHash: row.artifact_hash,
      entrypointName: row.entrypoint_name,
      routeBase: row.route_base,
      runtime: JSON.parse(row.runtime_authority_json),
    });
  } catch {
    return null;
  }
}

function normalizeAuthority(authority: AppRpcScheduleAuthority): AppRpcScheduleAuthority {
  if (
    !authority
    || typeof authority.key !== "string"
    || authority.key.length === 0
    || !Number.isSafeInteger(authority.ownerUid)
    || authority.ownerUid < 0
    || !authority.ownerUsername
    || !authority.kernelUsername
    || !Number.isSafeInteger(authority.kernelGeneration)
    || authority.kernelGeneration <= 0
    || !authority.packageId
    || !authority.packageName
    || !Number.isSafeInteger(authority.packageUpdatedAt)
    || authority.packageUpdatedAt <= 0
    || !authority.artifactHash
    || !authority.entrypointName
    || !authority.routeBase
    || !authority.runtime
    || typeof authority.runtime !== "object"
  ) {
    throw new Error("daemon schedule authority is invalid");
  }
  return authority;
}

function physicalScheduleKey(authorityKey: string, logicalKey: string): string {
  return `${authorityKey}\u001f${logicalKey}`;
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
