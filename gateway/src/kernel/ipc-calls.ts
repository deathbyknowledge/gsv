export type IpcCallStatus = "pending" | "completed" | "timed_out";

export type IpcCallRecord = {
  callId: string;
  sourcePid: string;
  sourceRunId: string | null;
  targetPid: string;
  targetRunId: string;
  status: IpcCallStatus;
  deadlineAt: number;
  createdAt: number;
  response: unknown;
  error: string | null;
};

type IpcCallRow = {
  call_id: string;
  source_pid: string;
  source_run_id: string | null;
  target_pid: string;
  target_run_id: string;
  status: string;
  deadline_at: number;
  created_at: number;
  response_json: string;
  error: string | null;
};

export class IpcCallStore {
  constructor(private readonly sql: SqlStorage) {}

  create(input: {
    callId: string;
    uid: number;
    sourcePid: string;
    sourceRunId: string | null;
    targetPid: string;
    targetRunId: string;
    deadlineAt: number;
  }): void {
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO ipc_calls (
        call_id, uid, source_pid, source_run_id, target_pid, target_run_id, status,
        deadline_at, created_at, updated_at, response_json, error
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, 'null', NULL)`,
      input.callId,
      input.uid,
      input.sourcePid,
      input.sourceRunId,
      input.targetPid,
      input.targetRunId,
      input.deadlineAt,
      now,
      now,
    );
  }

  cancelBySourceRun(input: {
    uid: number;
    sourcePid: string;
    sourceRunId: string;
  }): void {
    this.sql.exec(
      `DELETE FROM ipc_calls
        WHERE uid = ?
          AND source_pid = ?
          AND source_run_id = ?`,
      input.uid,
      input.sourcePid,
      input.sourceRunId,
    );
  }

  cancelBySourcePid(input: { uid: number; sourcePid: string }): void {
    this.sql.exec(
      "DELETE FROM ipc_calls WHERE uid = ? AND source_pid = ?",
      input.uid,
      input.sourcePid,
    );
  }

  remove(callId: string): void {
    this.sql.exec(
      "DELETE FROM ipc_calls WHERE call_id = ?",
      callId,
    );
  }

  completeByRun(input: {
    uid: number;
    targetPid: string;
    runId: string;
    response: unknown;
    error?: string | null;
  }): string[] {
    const now = Date.now();
    return this.sql.exec<{ call_id: string }>(
      `UPDATE ipc_calls
          SET status = 'completed',
              response_json = ?,
              error = ?,
              updated_at = ?
        WHERE uid = ?
          AND target_pid = ?
          AND target_run_id = ?
          AND status = 'pending'
          AND deadline_at > ?
        RETURNING call_id`,
      JSON.stringify(input.response ?? null),
      input.error ?? null,
      now,
      input.uid,
      input.targetPid,
      input.runId,
      now,
    ).toArray().map((row) => row.call_id);
  }

  failByTargetPid(input: {
    uid: number;
    targetPid: string;
    error: string;
  }): string[] {
    const now = Date.now();
    return this.sql.exec<{ call_id: string }>(
      `UPDATE ipc_calls
          SET status = 'completed',
              response_json = 'null',
              error = ?,
              updated_at = ?
        WHERE uid = ?
          AND target_pid = ?
          AND status = 'pending'
        RETURNING call_id`,
      input.error,
      now,
      input.uid,
      input.targetPid,
    ).toArray().map((row) => row.call_id);
  }

  timeout(callId: string, now = Date.now()): boolean {
    const cursor = this.sql.exec(
      `UPDATE ipc_calls
          SET status = 'timed_out',
              error = 'IPC call timed out',
              updated_at = ?
        WHERE call_id = ?
          AND status = 'pending'
          AND deadline_at <= ?`,
      now,
      callId,
      now,
    );
    return cursor.rowsWritten > 0;
  }

  claimDelivery(callId: string): IpcCallRecord | null {
    const now = Date.now();
    const rows = this.sql.exec<IpcCallRow>(
      `UPDATE ipc_calls
          SET delivery_started_at = ?,
              updated_at = ?
        WHERE call_id = ?
          AND status IN ('completed', 'timed_out')
          AND delivery_started_at IS NULL
        RETURNING *`,
      now,
      now,
      callId,
    ).toArray();
    return rows[0] ? toIpcCallRecord(rows[0]) : null;
  }

  releaseDelivery(callId: string): void {
    this.sql.exec(
      `UPDATE ipc_calls
          SET delivery_started_at = NULL,
              updated_at = ?
        WHERE call_id = ?
          AND status IN ('completed', 'timed_out')`,
      Date.now(),
      callId,
    );
  }

  recoverDeliveryIds(): string[] {
    return this.sql.exec<{ call_id: string }>(
      `UPDATE ipc_calls
          SET delivery_started_at = NULL
        WHERE status IN ('completed', 'timed_out')
        RETURNING call_id`,
    ).toArray().map((row) => row.call_id);
  }

  get(callId: string): IpcCallRecord | null {
    const rows = this.sql.exec<IpcCallRow>(
      "SELECT * FROM ipc_calls WHERE call_id = ? LIMIT 1",
      callId,
    ).toArray();
    return rows[0] ? toIpcCallRecord(rows[0]) : null;
  }
}

function toIpcCallRecord(row: IpcCallRow): IpcCallRecord {
  return {
    callId: row.call_id,
    sourcePid: row.source_pid,
    sourceRunId: row.source_run_id,
    targetPid: row.target_pid,
    targetRunId: row.target_run_id,
    status: row.status as IpcCallStatus,
    deadlineAt: row.deadline_at,
    createdAt: row.created_at,
    response: JSON.parse(row.response_json),
    error: row.error,
  };
}
