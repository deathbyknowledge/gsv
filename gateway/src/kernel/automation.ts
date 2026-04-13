import type { AiContextProfile } from "../syscalls/ai";
import type { ProcContextFile } from "../syscalls/proc";

export type AutomationJobStatus = "queued" | "running" | "completed" | "failed";

export type AutomationJobRecord = {
  jobId: string;
  uid: number;
  profile: AiContextProfile;
  triggerSignal: string;
  dedupeKey: string;
  sourcePid: string | null;
  workspaceId: string | null;
  label: string | null;
  sourceMessageCount: number;
  sourceEstimatedTokens: number;
  sourceInputTokens: number | null;
  assignmentContextFiles: ProcContextFile[];
  status: AutomationJobStatus;
  workerPid: string | null;
  runId: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
};

export class AutomationStore {
  constructor(private readonly sql: SqlStorage) {}

  init(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS automation_kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS automation_jobs (
        job_id TEXT PRIMARY KEY,
        uid INTEGER NOT NULL,
        profile TEXT NOT NULL,
        trigger_signal TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        source_pid TEXT,
        workspace_id TEXT,
        label TEXT,
        source_message_count INTEGER NOT NULL DEFAULT 0,
        source_estimated_tokens INTEGER NOT NULL DEFAULT 0,
        source_input_tokens INTEGER,
        assignment_context_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL,
        worker_pid TEXT,
        run_id TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_automation_jobs_status_created ON automation_jobs (status, created_at ASC)",
    );
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_automation_jobs_dedupe_status ON automation_jobs (dedupe_key, status)",
    );
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_automation_jobs_run_id ON automation_jobs (run_id)",
    );

    try {
      this.sql.exec("ALTER TABLE automation_jobs ADD COLUMN source_message_count INTEGER NOT NULL DEFAULT 0");
    } catch {}
    try {
      this.sql.exec("ALTER TABLE automation_jobs ADD COLUMN source_estimated_tokens INTEGER NOT NULL DEFAULT 0");
    } catch {}
    try {
      this.sql.exec("ALTER TABLE automation_jobs ADD COLUMN source_input_tokens INTEGER");
    } catch {}
  }

  enqueue(input: {
    uid: number;
    profile: AiContextProfile;
    triggerSignal: string;
    dedupeKey: string;
    sourcePid?: string | null;
    workspaceId?: string | null;
    label?: string | null;
    sourceMessageCount?: number;
    sourceEstimatedTokens?: number;
    sourceInputTokens?: number | null;
    assignmentContextFiles: ProcContextFile[];
  }): { job: AutomationJobRecord; created: boolean } {
    const existing = this.findActiveByDedupe(input.dedupeKey);
    if (existing) {
      return { job: existing, created: false };
    }

    const now = Date.now();
    const job: AutomationJobRecord = {
      jobId: crypto.randomUUID(),
      uid: input.uid,
      profile: input.profile,
      triggerSignal: input.triggerSignal,
      dedupeKey: input.dedupeKey,
      sourcePid: input.sourcePid ?? null,
      workspaceId: input.workspaceId ?? null,
      label: input.label ?? null,
      sourceMessageCount: input.sourceMessageCount ?? 0,
      sourceEstimatedTokens: input.sourceEstimatedTokens ?? 0,
      sourceInputTokens: input.sourceInputTokens ?? null,
      assignmentContextFiles: input.assignmentContextFiles,
      status: "queued",
      workerPid: null,
      runId: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };

    this.sql.exec(
      `INSERT INTO automation_jobs (
        job_id, uid, profile, trigger_signal, dedupe_key, source_pid, workspace_id,
        label, source_message_count, source_estimated_tokens, source_input_tokens,
        assignment_context_json, status, worker_pid, run_id, error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      job.jobId,
      job.uid,
      job.profile,
      job.triggerSignal,
      job.dedupeKey,
      job.sourcePid,
      job.workspaceId,
      job.label,
      job.sourceMessageCount,
      job.sourceEstimatedTokens,
      job.sourceInputTokens,
      JSON.stringify(job.assignmentContextFiles),
      job.status,
      job.workerPid,
      job.runId,
      job.error,
      job.createdAt,
      job.updatedAt,
    );

    return { job, created: true };
  }

  listQueued(limit = 8): AutomationJobRecord[] {
    return [...this.sql.exec<RowShape>(
      "SELECT * FROM automation_jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT ?",
      limit,
    )].map(toJobRecord);
  }

  getByRunId(runId: string): AutomationJobRecord | null {
    const rows = [...this.sql.exec<RowShape>(
      "SELECT * FROM automation_jobs WHERE run_id = ? LIMIT 1",
      runId,
    )];
    return rows[0] ? toJobRecord(rows[0]) : null;
  }

  getLatestCompletedByDedupe(dedupeKey: string): AutomationJobRecord | null {
    const rows = [...this.sql.exec<RowShape>(
      `SELECT * FROM automation_jobs
       WHERE dedupe_key = ? AND status = 'completed'
       ORDER BY updated_at DESC
       LIMIT 1`,
      dedupeKey,
    )];
    return rows[0] ? toJobRecord(rows[0]) : null;
  }

  markRunning(jobId: string, workerPid: string, runId: string): void {
    this.sql.exec(
      `UPDATE automation_jobs
         SET status = 'running', worker_pid = ?, run_id = ?, error = NULL, updated_at = ?
       WHERE job_id = ?`,
      workerPid,
      runId,
      Date.now(),
      jobId,
    );
  }

  completeForRun(runId: string): void {
    this.sql.exec(
      `UPDATE automation_jobs
         SET status = 'completed', updated_at = ?
       WHERE run_id = ?`,
      Date.now(),
      runId,
    );
  }

  failForRun(runId: string, error: string): void {
    this.sql.exec(
      `UPDATE automation_jobs
         SET status = 'failed', error = ?, updated_at = ?
       WHERE run_id = ?`,
      error,
      Date.now(),
      runId,
    );
  }

  markFailed(jobId: string, error: string): void {
    this.sql.exec(
      `UPDATE automation_jobs
         SET status = 'failed', error = ?, updated_at = ?
       WHERE job_id = ?`,
      error,
      Date.now(),
      jobId,
    );
  }

  private findActiveByDedupe(dedupeKey: string): AutomationJobRecord | null {
    const rows = [...this.sql.exec<RowShape>(
      `SELECT * FROM automation_jobs
       WHERE dedupe_key = ? AND status IN ('queued', 'running')
       ORDER BY created_at DESC
       LIMIT 1`,
      dedupeKey,
    )];
    return rows[0] ? toJobRecord(rows[0]) : null;
  }

  getMeta(key: string): string | null {
    const rows = [...this.sql.exec<{ value: string }>(
      "SELECT value FROM automation_kv WHERE key = ? LIMIT 1",
      key,
    )];
    return rows[0]?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO automation_kv (key, value) VALUES (?, ?)",
      key,
      value,
    );
  }

  deleteMeta(key: string): void {
    this.sql.exec("DELETE FROM automation_kv WHERE key = ?", key);
  }
}

type RowShape = {
  job_id: string;
  uid: number;
  profile: string;
  trigger_signal: string;
  dedupe_key: string;
  source_pid: string | null;
  workspace_id: string | null;
  label: string | null;
  source_message_count: number;
  source_estimated_tokens: number;
  source_input_tokens: number | null;
  assignment_context_json: string | null;
  status: AutomationJobStatus;
  worker_pid: string | null;
  run_id: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
};

function toJobRecord(row: RowShape): AutomationJobRecord {
  return {
    jobId: row.job_id,
    uid: row.uid,
    profile: row.profile as AiContextProfile,
    triggerSignal: row.trigger_signal,
    dedupeKey: row.dedupe_key,
    sourcePid: row.source_pid,
    workspaceId: row.workspace_id,
    label: row.label,
    sourceMessageCount: row.source_message_count ?? 0,
    sourceEstimatedTokens: row.source_estimated_tokens ?? 0,
    sourceInputTokens: row.source_input_tokens ?? null,
    assignmentContextFiles: parseContextFiles(row.assignment_context_json),
    status: row.status,
    workerPid: row.worker_pid,
    runId: row.run_id,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseContextFiles(value: string | null): ProcContextFile[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== "object") {
        return [];
      }
      const file = entry as { name?: unknown; text?: unknown };
      if (typeof file.name !== "string" || typeof file.text !== "string") {
        return [];
      }
      return [{ name: file.name, text: file.text }];
    });
  } catch {
    return [];
  }
}
