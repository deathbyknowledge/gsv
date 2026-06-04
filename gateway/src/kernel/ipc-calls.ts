export type IpcCallStatus = "pending" | "completed" | "timed_out";

export type IpcCallRecord = {
  callId: string;
  uid: number;
  sourcePid: string;
  targetPid: string;
  targetRunId: string | null;
  status: IpcCallStatus;
  deadlineAt: number;
  createdAt: number;
  updatedAt: number;
  response: unknown;
  error: string | null;
};

type IpcCallRow = {
  call_id: string;
  uid: number;
  source_pid: string;
  target_pid: string;
  target_run_id: string | null;
  status: string;
  deadline_at: number;
  created_at: number;
  updated_at: number;
  response_json: string;
  error: string | null;
};

export class IpcCallStore {
  constructor(private readonly sql: SqlStorage) {}

  create(input: {
    callId: string;
    uid: number;
    sourcePid: string;
    targetPid: string;
    deadlineAt: number;
  }): IpcCallRecord {
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO ipc_calls (
        call_id, uid, source_pid, target_pid, target_run_id, status,
        deadline_at, created_at, updated_at, response_json, error
      ) VALUES (?, ?, ?, ?, NULL, 'pending', ?, ?, ?, 'null', NULL)`,
      input.callId,
      input.uid,
      input.sourcePid,
      input.targetPid,
      input.deadlineAt,
      now,
      now,
    );
    return {
      callId: input.callId,
      uid: input.uid,
      sourcePid: input.sourcePid,
      targetPid: input.targetPid,
      targetRunId: null,
      status: "pending",
      deadlineAt: input.deadlineAt,
      createdAt: now,
      updatedAt: now,
      response: null,
      error: null,
    };
  }

  attachRun(callId: string, runId: string): IpcCallRecord | null {
    const now = Date.now();
    this.sql.exec(
      `UPDATE ipc_calls
          SET target_run_id = ?,
              updated_at = ?
        WHERE call_id = ?
          AND status = 'pending'`,
      runId,
      now,
      callId,
    );
    return this.get(callId);
  }

  remove(callId: string): boolean {
    const cursor = this.sql.exec(
      "DELETE FROM ipc_calls WHERE call_id = ?",
      callId,
    );
    return cursor.rowsWritten > 0;
  }

  completeByRun(input: {
    uid: number;
    targetPid: string;
    runId: string;
    response: unknown;
    error?: string | null;
  }): IpcCallRecord[] {
    const now = Date.now();
    const pending = this.findPendingByRun(input.uid, input.targetPid, input.runId, now);
    for (const record of pending) {
      this.sql.exec(
        `UPDATE ipc_calls
            SET status = 'completed',
                response_json = ?,
                error = ?,
                updated_at = ?
          WHERE call_id = ?
            AND status = 'pending'`,
        JSON.stringify(input.response ?? null),
        input.error ?? null,
        now,
        record.callId,
      );
    }
    return pending.map((record) => ({
      ...record,
      status: "completed",
      response: input.response ?? null,
      error: input.error ?? null,
      updatedAt: now,
    }));
  }

  timeout(callId: string, now = Date.now()): IpcCallRecord | null {
    const record = this.get(callId);
    if (!record || record.status !== "pending" || record.deadlineAt > now) {
      return null;
    }

    this.sql.exec(
      `UPDATE ipc_calls
          SET status = 'timed_out',
              error = ?,
              updated_at = ?
        WHERE call_id = ?
          AND status = 'pending'`,
      `IPC call timed out after deadline ${new Date(record.deadlineAt).toISOString()}`,
      now,
      callId,
    );

    return {
      ...record,
      status: "timed_out",
      error: `IPC call timed out after deadline ${new Date(record.deadlineAt).toISOString()}`,
      updatedAt: now,
    };
  }

  get(callId: string): IpcCallRecord | null {
    const rows = this.sql.exec<IpcCallRow>(
      "SELECT * FROM ipc_calls WHERE call_id = ? LIMIT 1",
      callId,
    ).toArray();
    return rows[0] ? toIpcCallRecord(rows[0]) : null;
  }

  private findPendingByRun(uid: number, targetPid: string, runId: string, now: number): IpcCallRecord[] {
    return this.sql.exec<IpcCallRow>(
      `SELECT * FROM ipc_calls
        WHERE uid = ?
          AND target_pid = ?
          AND target_run_id = ?
          AND status = 'pending'
          AND deadline_at > ?
        ORDER BY created_at ASC`,
      uid,
      targetPid,
      runId,
      now,
    ).toArray().map(toIpcCallRecord);
  }
}

function toIpcCallRecord(row: IpcCallRow): IpcCallRecord {
  return {
    callId: row.call_id,
    uid: row.uid,
    sourcePid: row.source_pid,
    targetPid: row.target_pid,
    targetRunId: row.target_run_id,
    status: row.status === "completed"
      ? "completed"
      : row.status === "timed_out"
        ? "timed_out"
        : "pending",
    deadlineAt: row.deadline_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    response: parseJson(row.response_json),
    error: row.error,
  };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
