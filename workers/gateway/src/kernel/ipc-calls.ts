/** A call in flight. Its row goes when the call ends, and its answer goes on the log. */
export type IpcCallRecord = {
  callId: string;
  ownerUid: number;
  sourcePid: string;
  sourceRunId: string | null;
  targetPid: string;
  targetRunId: string;
  supervised: boolean;
  deadlineAt: number;
  createdAt: number;
  responsibilityId: string | null;
};

type IpcCallRow = {
  call_id: string;
  uid: number;
  source_pid: string;
  source_run_id: string | null;
  target_pid: string;
  target_run_id: string;
  supervised: number;
  deadline_at: number;
  created_at: number;
  responsibility_id: string | null;
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
    supervised?: boolean;
    responsibilityId?: string;
  }): void {
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO ipc_calls (
        call_id, uid, source_pid, source_run_id, target_pid, target_run_id,
        supervised, deadline_at, created_at, updated_at, responsibility_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.callId,
      input.uid,
      input.sourcePid,
      input.sourceRunId,
      input.targetPid,
      input.targetRunId,
      input.supervised ? 1 : 0,
      input.deadlineAt,
      now,
      now,
      input.responsibilityId ?? null,
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
          AND source_run_id = ?
          AND responsibility_id IS NULL`,
      input.uid,
      input.sourcePid,
      input.sourceRunId,
    );
  }

  cancelBySourcePid(input: { uid: number; sourcePid: string }): void {
    this.sql.exec(
      `DELETE FROM ipc_calls
        WHERE uid = ?
          AND source_pid = ?
          AND responsibility_id IS NULL`,
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

  /** Ends the calls a target's run answers, except an unsupervised one already past its deadline: its timeout answers it. */
  endByRun(input: {
    uid: number;
    targetPid: string;
    runId: string;
  }): IpcCallRecord[] {
    const now = Date.now();
    return this.sql.exec<IpcCallRow>(
      `DELETE FROM ipc_calls
        WHERE uid = ?
          AND target_pid = ?
          AND target_run_id = ?
          AND (supervised = 1 OR deadline_at > ?)
        RETURNING *`,
      input.uid,
      input.targetPid,
      input.runId,
      now,
    ).toArray().map(toIpcCallRecord);
  }

  renewDeadline(callId: string, deadlineAt: number): IpcCallRecord | null {
    const now = Date.now();
    const rows = this.sql.exec<IpcCallRow>(
      `UPDATE ipc_calls
          SET deadline_at = ?,
              supervised = 1,
              updated_at = ?
        WHERE call_id = ?
        RETURNING *`,
      deadlineAt,
      now,
      callId,
    ).toArray();
    return rows[0] ? toIpcCallRecord(rows[0]) : null;
  }

  /** Ends every call to a target, as when it is reset or killed. */
  endByTarget(input: {
    uid: number;
    targetPid: string;
  }): IpcCallRecord[] {
    return this.sql.exec<IpcCallRow>(
      `DELETE FROM ipc_calls
        WHERE uid = ?
          AND target_pid = ?
        RETURNING *`,
      input.uid,
      input.targetPid,
    ).toArray().map(toIpcCallRecord);
  }

  findPendingByTargetRun(input: {
    uid: number;
    targetPid: string;
    targetRunId: string;
  }): IpcCallRecord | null {
    const rows = this.sql.exec<IpcCallRow>(
      `SELECT * FROM ipc_calls
        WHERE uid = ?
          AND target_pid = ?
          AND target_run_id = ?
        LIMIT 1`,
      input.uid,
      input.targetPid,
      input.targetRunId,
    ).toArray();
    return rows[0] ? toIpcCallRecord(rows[0]) : null;
  }

  /** Ends a call once its deadline has passed. */
  endOverdue(callId: string, now = Date.now()): IpcCallRecord | null {
    const rows = this.sql.exec<IpcCallRow>(
      `DELETE FROM ipc_calls
        WHERE call_id = ?
          AND deadline_at <= ?
        RETURNING *`,
      callId,
      now,
    ).toArray();
    return rows[0] ? toIpcCallRecord(rows[0]) : null;
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
    ownerUid: row.uid,
    sourcePid: row.source_pid,
    sourceRunId: row.source_run_id,
    targetPid: row.target_pid,
    targetRunId: row.target_run_id,
    supervised: row.supervised === 1,
    deadlineAt: row.deadline_at,
    createdAt: row.created_at,
    responsibilityId: row.responsibility_id,
  };
}
