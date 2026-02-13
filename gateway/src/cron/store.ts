import type { CronJob, CronMode, CronRun } from "./types";

type JobRow = {
  id: string;
  agent_id: string;
  name: string;
  description: string | null;
  enabled: number;
  delete_after_run: number;
  schedule_json: string;
  payload_json: string;
  session_target: string;
  wake_mode: string;
  created_at_ms: number;
  updated_at_ms: number;
  next_run_at_ms: number | null;
  running_at_ms: number | null;
  last_run_at_ms: number | null;
  last_status: string | null;
  last_error: string | null;
  last_duration_ms: number | null;
};

type RunRow = {
  id: number;
  job_id: string;
  ts: number;
  status: string;
  error: string | null;
  summary: string | null;
  duration_ms: number | null;
  next_run_at_ms: number | null;
};

export class CronStore {
  constructor(private readonly sql: SqlStorage) {
    this.init();
  }

  private init(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS cron_jobs (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        enabled INTEGER NOT NULL,
        delete_after_run INTEGER NOT NULL DEFAULT 0,
        schedule_json TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        session_target TEXT NOT NULL,
        wake_mode TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        next_run_at_ms INTEGER,
        running_at_ms INTEGER,
        last_run_at_ms INTEGER,
        last_status TEXT,
        last_error TEXT,
        last_duration_ms INTEGER
      )
    `);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS cron_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        summary TEXT,
        duration_ms INTEGER,
        next_run_at_ms INTEGER
      )
    `);

    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_cron_jobs_due ON cron_jobs(enabled, next_run_at_ms)`,
    );
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_cron_runs_job_ts ON cron_runs(job_id, ts DESC, id DESC)`,
    );
  }

  listJobs(opts?: {
    agentId?: string;
    includeDisabled?: boolean;
    limit?: number;
    offset?: number;
  }): { jobs: CronJob[]; count: number } {
    const limit = clampInt(opts?.limit, 1, 500, 200);
    const offset = clampInt(opts?.offset, 0, 1_000_000, 0);
    const includeDisabled = opts?.includeDisabled ?? true;
    const agentId = opts?.agentId?.trim() || undefined;

    const where: string[] = [];
    const params: Array<string | number | null> = [];

    if (agentId) {
      where.push(`agent_id = ?`);
      params.push(agentId);
    }

    if (!includeDisabled) {
      where.push(`enabled = 1`);
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

    const countRow = this.sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) as count FROM cron_jobs ${whereClause}`,
        ...params,
      )
      .toArray()[0];

    const rows = this.sql
      .exec<JobRow>(
        `
          SELECT *
          FROM cron_jobs
          ${whereClause}
          ORDER BY next_run_at_ms IS NULL, next_run_at_ms ASC, created_at_ms ASC
          LIMIT ? OFFSET ?
        `,
        ...params,
        limit,
        offset,
      )
      .toArray();

    return {
      jobs: rows.map((row) => this.rowToJob(row)),
      count: countRow?.count ?? 0,
    };
  }

  getJob(id: string): CronJob | undefined {
    const rows = this.sql
      .exec<JobRow>(`SELECT * FROM cron_jobs WHERE id = ? LIMIT 1`, id)
      .toArray();
    return rows.length > 0 ? this.rowToJob(rows[0]) : undefined;
  }

  createJob(job: CronJob): void {
    const { sessionTarget, payloadJson } = specToRow(job.spec);
    this.sql.exec(
      `
        INSERT INTO cron_jobs (
          id, agent_id, name, description, enabled, delete_after_run,
          schedule_json, payload_json, session_target, wake_mode,
          created_at_ms, updated_at_ms,
          next_run_at_ms, running_at_ms, last_run_at_ms,
          last_status, last_error, last_duration_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      job.id,
      job.agentId,
      job.name,
      job.description ?? null,
      job.enabled ? 1 : 0,
      job.deleteAfterRun ? 1 : 0,
      JSON.stringify(job.schedule),
      payloadJson,
      sessionTarget,
      "now", // wake_mode column kept for schema compat, always "now"
      job.createdAtMs,
      job.updatedAtMs,
      job.state.nextRunAtMs ?? null,
      job.state.runningAtMs ?? null,
      job.state.lastRunAtMs ?? null,
      job.state.lastStatus ?? null,
      job.state.lastError ?? null,
      job.state.lastDurationMs ?? null,
    );
  }

  updateJob(job: CronJob): void {
    const { sessionTarget, payloadJson } = specToRow(job.spec);
    this.sql.exec(
      `
        UPDATE cron_jobs
        SET
          agent_id = ?,
          name = ?,
          description = ?,
          enabled = ?,
          delete_after_run = ?,
          schedule_json = ?,
          payload_json = ?,
          session_target = ?,
          wake_mode = ?,
          updated_at_ms = ?,
          next_run_at_ms = ?,
          running_at_ms = ?,
          last_run_at_ms = ?,
          last_status = ?,
          last_error = ?,
          last_duration_ms = ?
        WHERE id = ?
      `,
      job.agentId,
      job.name,
      job.description ?? null,
      job.enabled ? 1 : 0,
      job.deleteAfterRun ? 1 : 0,
      JSON.stringify(job.schedule),
      payloadJson,
      sessionTarget,
      "now",
      job.updatedAtMs,
      job.state.nextRunAtMs ?? null,
      job.state.runningAtMs ?? null,
      job.state.lastRunAtMs ?? null,
      job.state.lastStatus ?? null,
      job.state.lastError ?? null,
      job.state.lastDurationMs ?? null,
      job.id,
    );
  }

  removeJob(id: string, opts?: { deleteRuns?: boolean }): boolean {
    const existing = this.getJob(id);
    if (!existing) {
      return false;
    }

    this.sql.exec(`DELETE FROM cron_jobs WHERE id = ?`, id);
    if (opts?.deleteRuns !== false) {
      this.sql.exec(`DELETE FROM cron_runs WHERE job_id = ?`, id);
    }
    return true;
  }

  countJobs(agentId?: string): number {
    if (agentId) {
      const row = this.sql
        .exec<{ count: number }>(
          `SELECT COUNT(*) as count FROM cron_jobs WHERE agent_id = ?`,
          agentId,
        )
        .toArray()[0];
      return row?.count ?? 0;
    }

    const row = this.sql
      .exec<{ count: number }>(`SELECT COUNT(*) as count FROM cron_jobs`)
      .toArray()[0];
    return row?.count ?? 0;
  }

  countDue(nowMs: number): number {
    const row = this.sql
      .exec<{ count: number }>(
        `
          SELECT COUNT(*) as count
          FROM cron_jobs
          WHERE enabled = 1
            AND next_run_at_ms IS NOT NULL
            AND next_run_at_ms <= ?
            AND running_at_ms IS NULL
        `,
        nowMs,
      )
      .toArray()[0];
    return row?.count ?? 0;
  }

  countRunning(): number {
    const row = this.sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) as count FROM cron_jobs WHERE running_at_ms IS NOT NULL`,
      )
      .toArray()[0];
    return row?.count ?? 0;
  }

  nextDueAtMs(): number | undefined {
    const rows = this.sql
      .exec<{ next_run_at_ms: number | null }>(
        `
          SELECT next_run_at_ms
          FROM cron_jobs
          WHERE enabled = 1
            AND next_run_at_ms IS NOT NULL
          ORDER BY next_run_at_ms ASC
          LIMIT 1
        `,
      )
      .toArray();
    return rows.length > 0 ? (rows[0].next_run_at_ms ?? undefined) : undefined;
  }

  dueJobs(nowMs: number, limit: number): CronJob[] {
    const cappedLimit = clampInt(limit, 1, 500, 100);
    const rows = this.sql
      .exec<JobRow>(
        `
          SELECT *
          FROM cron_jobs
          WHERE enabled = 1
            AND next_run_at_ms IS NOT NULL
            AND next_run_at_ms <= ?
            AND running_at_ms IS NULL
          ORDER BY next_run_at_ms ASC, created_at_ms ASC
          LIMIT ?
        `,
        nowMs,
        cappedLimit,
      )
      .toArray();

    return rows.map((row) => this.rowToJob(row));
  }

  addRun(
    run: Omit<CronRun, "id">,
    opts?: { maxHistoryPerJob?: number },
  ): void {
    this.sql.exec(
      `
        INSERT INTO cron_runs (
          job_id, ts, status, error, summary, duration_ms, next_run_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      run.jobId,
      run.ts,
      run.status,
      run.error ?? null,
      run.summary ?? null,
      run.durationMs ?? null,
      run.nextRunAtMs ?? null,
    );

    const maxHistory = clampInt(opts?.maxHistoryPerJob, 1, 50_000, 200);
    this.sql.exec(
      `
        DELETE FROM cron_runs
        WHERE job_id = ?
          AND id NOT IN (
            SELECT id
            FROM cron_runs
            WHERE job_id = ?
            ORDER BY ts DESC, id DESC
            LIMIT ?
          )
      `,
      run.jobId,
      run.jobId,
      maxHistory,
    );
  }

  listRuns(opts?: {
    jobId?: string;
    limit?: number;
    offset?: number;
  }): { runs: CronRun[]; count: number } {
    const limit = clampInt(opts?.limit, 1, 2000, 200);
    const offset = clampInt(opts?.offset, 0, 1_000_000, 0);
    const jobId = opts?.jobId?.trim() || undefined;

    if (jobId) {
      const countRow = this.sql
        .exec<{ count: number }>(
          `SELECT COUNT(*) as count FROM cron_runs WHERE job_id = ?`,
          jobId,
        )
        .toArray()[0];
      const rows = this.sql
        .exec<RunRow>(
          `
            SELECT *
            FROM cron_runs
            WHERE job_id = ?
            ORDER BY ts DESC, id DESC
            LIMIT ? OFFSET ?
          `,
          jobId,
          limit,
          offset,
        )
        .toArray();

      return {
        runs: rows.map((row) => this.rowToRun(row)),
        count: countRow?.count ?? 0,
      };
    }

    const countRow = this.sql
      .exec<{ count: number }>(`SELECT COUNT(*) as count FROM cron_runs`)
      .toArray()[0];
    const rows = this.sql
      .exec<RunRow>(
        `
          SELECT *
          FROM cron_runs
          ORDER BY ts DESC, id DESC
          LIMIT ? OFFSET ?
        `,
        limit,
        offset,
      )
      .toArray();

    return {
      runs: rows.map((row) => this.rowToRun(row)),
      count: countRow?.count ?? 0,
    };
  }

  /**
   * Convert a SQL row to a CronJob, handling migration from old
   * (sessionTarget + payload) format to new (spec) format.
   */
  private rowToJob(row: JobRow): CronJob {
    return {
      id: row.id,
      agentId: row.agent_id,
      name: row.name,
      description: row.description ?? undefined,
      enabled: row.enabled === 1,
      deleteAfterRun: row.delete_after_run === 1 ? true : undefined,
      schedule: JSON.parse(row.schedule_json),
      spec: rowToSpec(row.session_target, row.payload_json),
      createdAtMs: row.created_at_ms,
      updatedAtMs: row.updated_at_ms,
      state: {
        nextRunAtMs: row.next_run_at_ms ?? undefined,
        runningAtMs: row.running_at_ms ?? undefined,
        lastRunAtMs: row.last_run_at_ms ?? undefined,
        lastStatus: (row.last_status as CronJob["state"]["lastStatus"]) ?? undefined,
        lastError: row.last_error ?? undefined,
        lastDurationMs: row.last_duration_ms ?? undefined,
      },
    };
  }

  private rowToRun(row: RunRow): CronRun {
    return {
      id: row.id,
      jobId: row.job_id,
      ts: row.ts,
      status: row.status as CronRun["status"],
      error: row.error ?? undefined,
      summary: row.summary ?? undefined,
      durationMs: row.duration_ms ?? undefined,
      nextRunAtMs: row.next_run_at_ms ?? undefined,
    };
  }
}

/**
 * Convert a CronMode spec into the SQL row columns.
 * Maps "systemEvent" → session_target="main" and "task" → session_target="isolated"
 * for backward compatibility with the existing schema.
 */
function specToRow(spec: CronMode): { sessionTarget: string; payloadJson: string } {
  if (spec.mode === "systemEvent") {
    return {
      sessionTarget: "main",
      payloadJson: JSON.stringify({ kind: "systemEvent", text: spec.text }),
    };
  }

  // mode === "task"
  const payload: Record<string, unknown> = {
    kind: "agentTurn",
    message: spec.message,
  };
  if (spec.model !== undefined) payload.model = spec.model;
  if (spec.thinking !== undefined) payload.thinking = spec.thinking;
  if (spec.timeoutSeconds !== undefined) payload.timeoutSeconds = spec.timeoutSeconds;
  if (spec.deliver !== undefined) payload.deliver = spec.deliver;
  if (spec.channel !== undefined) payload.channel = spec.channel;
  if (spec.to !== undefined) payload.to = spec.to;
  if (spec.bestEffortDeliver !== undefined) payload.bestEffortDeliver = spec.bestEffortDeliver;
  return {
    sessionTarget: "isolated",
    payloadJson: JSON.stringify(payload),
  };
}

/**
 * Convert SQL row columns back into a CronMode spec.
 * Handles migration from old payload format (kind: "systemEvent"/"agentTurn")
 * to new spec format (mode: "systemEvent"/"task").
 */
function rowToSpec(sessionTarget: string, payloadJson: string): CronMode {
  const payload = JSON.parse(payloadJson);

  // Old format used payload.kind; new format uses spec.mode.
  // We normalize based on sessionTarget which is the authoritative column.
  if (sessionTarget === "isolated" || payload.kind === "agentTurn") {
    return {
      mode: "task",
      message: payload.message ?? payload.text ?? "",
      model: payload.model,
      thinking: payload.thinking,
      timeoutSeconds: payload.timeoutSeconds,
      deliver: payload.deliver,
      channel: payload.channel,
      to: payload.to,
      bestEffortDeliver: payload.bestEffortDeliver,
    };
  }

  // Default: systemEvent (sessionTarget === "main" or anything else)
  return {
    mode: "systemEvent",
    text: payload.text ?? payload.message ?? "",
  };
}

function clampInt(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(value as number)));
}
