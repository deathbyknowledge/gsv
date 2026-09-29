import { z } from "zod";
import type { ProcHistoryEventAudience } from "@humansandmachines/gsv/protocol";

type SignalWatchState = {} | null;

export type SignalWatchTargetInput = {
  kind: "process";
  processId: string;
};

export type SignalWatchStatus = "active" | "failed";

export type SignalWatchRecord = {
  watchId: string;
  uid: number;
  targetProcessId: string;
  signal: "target.status";
  sourceTargetId: string;
  audience: ProcHistoryEventAudience;
  revision: number;
  key: string | null;
  state: SignalWatchState;
  once: boolean;
  status: SignalWatchStatus;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
};

export class SignalWatchStore {
  constructor(private readonly sql: SqlStorage) {}

  upsert(input: {
    uid: number;
    target: SignalWatchTargetInput;
    signal: "target.status";
    sourceTargetId: string;
    audience: ProcHistoryEventAudience;
    key?: string | null;
    state?: unknown;
    once?: boolean;
    expiresAt?: number | null;
  }): SignalWatchUpsertResult {
    const now = Date.now();
    const existing = input.key
      ? this.findActiveByKey(input.uid, input.target, input.key)
      : null;

    if (existing) {
      this.sql.exec(
        `UPDATE signal_watches
           SET target_type = 'process', target_process_id = ?, signal = ?,
               state_json = ?, once_only = ?, error = NULL, updated_at = ?, expires_at = ?,
               source_target_id = ?, event_audience = ?, revision = revision + 1
         WHERE watch_id = ?`,
        input.target.processId,
        input.signal,
        JSON.stringify(input.state ?? null),
        input.once === false ? 0 : 1,
        now,
        input.expiresAt ?? null,
        input.sourceTargetId,
        input.audience,
        existing.watchId,
      );
      return {
        watch: {
          ...existing,
          targetProcessId: input.target.processId,
          signal: input.signal,
          sourceTargetId: input.sourceTargetId,
          audience: input.audience,
          revision: existing.revision + 1,
          state: input.state ?? null,
          once: input.once !== false,
          error: null,
          updatedAt: now,
          expiresAt: input.expiresAt ?? null,
        },
        created: false,
      };
    }

    const watch: SignalWatchRecord = {
      watchId: crypto.randomUUID(),
      uid: input.uid,
      targetProcessId: input.target.processId,
      signal: input.signal,
      sourceTargetId: input.sourceTargetId,
      audience: input.audience,
      revision: 1,
      key: input.key ?? null,
      state: input.state ?? null,
      once: input.once !== false,
      status: "active",
      error: null,
      createdAt: now,
      updatedAt: now,
      expiresAt: input.expiresAt ?? null,
    };

    this.sql.exec(
      `INSERT INTO signal_watches (
        watch_id, uid, target_type, target_process_id, signal, dedupe_key,
        state_json, once_only, status, error, created_at, updated_at, expires_at,
        source_target_id, event_audience
      ) VALUES (?, ?, 'process', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      watch.watchId,
      watch.uid,
      watch.targetProcessId,
      watch.signal,
      watch.key,
      JSON.stringify(watch.state),
      watch.once ? 1 : 0,
      watch.status,
      watch.error,
      watch.createdAt,
      watch.updatedAt,
      watch.expiresAt,
      watch.sourceTargetId,
      watch.audience,
    );

    return { watch, created: true };
  }

  matchTarget(targetId: string, signal: "target.status"): SignalWatchRecord[] {
    const now = Date.now();
    this.sql.exec(
      "DELETE FROM signal_watches WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?",
      now,
    );
    return this.sql.exec<SignalWatchRow>(
      `SELECT * FROM signal_watches
       WHERE source_target_id = ? AND signal = ? AND status = 'active'
         AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY created_at ASC, watch_id ASC`,
      targetId, signal, now,
    ).toArray().map(toSignalWatchRecord);
  }

  isActiveRevision(watchId: string, revision: number): boolean {
    return this.sql.exec(
      `SELECT 1 FROM signal_watches WHERE watch_id = ? AND revision = ? AND status = 'active'
       AND (expires_at IS NULL OR expires_at > ?) LIMIT 1`,
      watchId, revision, Date.now(),
    ).toArray().length > 0;
  }

  deleteHandled(watchId: string, revision: number): void {
    this.sql.exec("DELETE FROM signal_watches WHERE watch_id = ? AND revision = ?", watchId, revision);
  }

  markFailed(watchId: string, error: string, revision: number): void {
    this.sql.exec(
      `UPDATE signal_watches
         SET status = 'failed', error = ?, updated_at = ?
       WHERE watch_id = ? AND revision = ?`,
      error,
      Date.now(),
      watchId,
      revision,
    );
  }

  removeById(uid: number, target: SignalWatchTargetInput, watchId: string): number {
    return this.sql.exec<{ watch_id: string }>(
      `DELETE FROM signal_watches
       WHERE uid = ? AND target_type = 'process' AND target_process_id = ? AND watch_id = ?
       RETURNING watch_id`,
      uid,
      target.processId,
      watchId,
    ).toArray().length;
  }

  removeByKey(uid: number, target: SignalWatchTargetInput, key: string): number {
    return this.sql.exec<{ watch_id: string }>(
      `DELETE FROM signal_watches
       WHERE uid = ? AND target_type = 'process' AND target_process_id = ? AND dedupe_key = ?
       RETURNING watch_id`,
      uid,
      target.processId,
      key,
    ).toArray().length;
  }

  private findActiveByKey(
    uid: number,
    target: SignalWatchTargetInput,
    key: string,
  ): SignalWatchRecord | null {
    const rows = [...this.sql.exec<SignalWatchRow>(
      `SELECT watch_id, uid, target_process_id, signal, dedupe_key,
              state_json, once_only, status, error, created_at, updated_at, expires_at,
              source_target_id, event_audience, revision
       FROM signal_watches
       WHERE uid = ?
         AND target_type = 'process'
         AND target_process_id = ?
         AND dedupe_key = ?
         AND status = 'active'
       ORDER BY created_at DESC
       LIMIT 1`,
      uid,
      target.processId,
      key,
    )];
    return rows[0] ? toSignalWatchRecord(rows[0]) : null;
  }
}

type SignalWatchRow = {
  watch_id: string;
  uid: number;
  target_process_id: string;
  signal: "target.status";
  source_target_id: string;
  event_audience: ProcHistoryEventAudience;
  revision: number;
  dedupe_key: string | null;
  state_json: string | null;
  once_only: number;
  status: SignalWatchStatus;
  error: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
};

type SignalWatchUpsertResult = { watch: SignalWatchRecord; created: boolean };

function toSignalWatchRecord(row: SignalWatchRow): SignalWatchRecord {
  return {
    watchId: row.watch_id,
    uid: row.uid,
    targetProcessId: row.target_process_id,
    signal: row.signal,
    sourceTargetId: row.source_target_id,
    audience: row.event_audience,
    revision: row.revision,
    key: row.dedupe_key,
    state: parseJsonValue(row.state_json),
    once: row.once_only !== 0,
    status: row.status,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}

function parseJsonValue(value: string | null): SignalWatchState {
  if (!value) return null;
  try {
    const parsed = z.json().safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
