export type SignalWatchStatus = "active" | "failed";
export type SignalWatchTargetKind = "app" | "process";

export type SignalWatchTargetInput =
  | {
      kind: "app";
      packageId: string;
      packageName: string;
      entrypointName: string;
      routeBase: string;
    }
  | {
      kind: "process";
      processId: string;
    };

export type SignalWatchRecord = {
  watchId: string;
  uid: number;
  targetKind: SignalWatchTargetKind;
  targetProcessId: string | null;
  packageId: string | null;
  packageName: string | null;
  entrypointName: string | null;
  routeBase: string | null;
  signal: string;
  processId: string | null;
  key: string | null;
  state: unknown;
  once: boolean;
  status: SignalWatchStatus;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
};

export class SignalWatchStore {
  constructor(private readonly sql: SqlStorage) {}

  init(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS signal_watches (
        watch_id TEXT PRIMARY KEY,
        uid INTEGER NOT NULL,
        package_id TEXT NOT NULL,
        package_name TEXT NOT NULL,
        entrypoint_name TEXT NOT NULL,
        route_base TEXT NOT NULL,
        signal TEXT NOT NULL,
        process_id TEXT,
        dedupe_key TEXT,
        state_json TEXT NOT NULL DEFAULT 'null',
        once_only INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'active',
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER
      )
    `);

    this.ensureColumn(
      "signal_watches",
      "target_type",
      "ALTER TABLE signal_watches ADD COLUMN target_type TEXT NOT NULL DEFAULT 'app'",
    );
    this.ensureColumn(
      "signal_watches",
      "target_process_id",
      "ALTER TABLE signal_watches ADD COLUMN target_process_id TEXT",
    );
    this.sql.exec(
      "UPDATE signal_watches SET target_type = 'app' WHERE target_type IS NULL OR target_type = ''",
    );

    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_signal_watches_active ON signal_watches (uid, signal, status, process_id, expires_at)",
    );
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_signal_watches_key ON signal_watches (uid, package_id, entrypoint_name, dedupe_key, status)",
    );
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_signal_watches_target_key ON signal_watches (uid, target_type, target_process_id, package_id, entrypoint_name, dedupe_key, status)",
    );
  }

  upsert(input: {
    uid: number;
    target: SignalWatchTargetInput;
    signal: string;
    processId?: string | null;
    key?: string | null;
    state?: unknown;
    once?: boolean;
    expiresAt?: number | null;
  }): { watch: SignalWatchRecord; created: boolean } {
    const now = Date.now();
    const existing = input.key
      ? this.findActiveByKey(input.uid, input.target, input.key)
      : null;

    if (existing) {
      this.sql.exec(
        `UPDATE signal_watches
           SET target_type = ?, target_process_id = ?, package_id = ?, package_name = ?, entrypoint_name = ?, route_base = ?,
               signal = ?, process_id = ?, state_json = ?, once_only = ?, error = NULL, updated_at = ?, expires_at = ?
         WHERE watch_id = ?`,
        input.target.kind,
        input.target.kind === "process" ? input.target.processId : null,
        input.target.kind === "app" ? input.target.packageId : "",
        input.target.kind === "app" ? input.target.packageName : "",
        input.target.kind === "app" ? input.target.entrypointName : "",
        input.target.kind === "app" ? input.target.routeBase : "",
        input.signal,
        input.processId ?? null,
        JSON.stringify(input.state ?? null),
        input.once === false ? 0 : 1,
        now,
        input.expiresAt ?? null,
        existing.watchId,
      );
      return {
        watch: {
          ...existing,
          targetKind: input.target.kind,
          targetProcessId: input.target.kind === "process" ? input.target.processId : null,
          packageId: input.target.kind === "app" ? input.target.packageId : null,
          packageName: input.target.kind === "app" ? input.target.packageName : null,
          entrypointName: input.target.kind === "app" ? input.target.entrypointName : null,
          routeBase: input.target.kind === "app" ? input.target.routeBase : null,
          signal: input.signal,
          processId: input.processId ?? null,
          state: input.state ?? null,
          once: input.once === false ? false : true,
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
      targetKind: input.target.kind,
      targetProcessId: input.target.kind === "process" ? input.target.processId : null,
      packageId: input.target.kind === "app" ? input.target.packageId : null,
      packageName: input.target.kind === "app" ? input.target.packageName : null,
      entrypointName: input.target.kind === "app" ? input.target.entrypointName : null,
      routeBase: input.target.kind === "app" ? input.target.routeBase : null,
      signal: input.signal,
      processId: input.processId ?? null,
      key: input.key ?? null,
      state: input.state ?? null,
      once: input.once === false ? false : true,
      status: "active",
      error: null,
      createdAt: now,
      updatedAt: now,
      expiresAt: input.expiresAt ?? null,
    };

    this.sql.exec(
      `INSERT INTO signal_watches (
        watch_id, uid, target_type, target_process_id, package_id, package_name, entrypoint_name, route_base, signal,
        process_id, dedupe_key, state_json, once_only, status, error, created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      watch.watchId,
      watch.uid,
      watch.targetKind,
      watch.targetProcessId,
      watch.packageId ?? "",
      watch.packageName ?? "",
      watch.entrypointName ?? "",
      watch.routeBase ?? "",
      watch.signal,
      watch.processId,
      watch.key,
      JSON.stringify(watch.state),
      watch.once ? 1 : 0,
      watch.status,
      watch.error,
      watch.createdAt,
      watch.updatedAt,
      watch.expiresAt,
    );

    return { watch, created: true };
  }

  match(uid: number, signal: string, processId?: string | null): SignalWatchRecord[] {
    const now = Date.now();
    this.sql.exec(
      "DELETE FROM signal_watches WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?",
      now,
    );

    return [...this.sql.exec<RowShape>(
      `SELECT * FROM signal_watches
       WHERE uid = ?
         AND signal = ?
         AND status = 'active'
         AND (process_id IS NULL OR process_id = ?)
         AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY created_at ASC`,
      uid,
      signal,
      processId ?? null,
      now,
    )].map(toSignalWatchRecord);
  }

  deleteHandled(watchId: string): void {
    this.sql.exec("DELETE FROM signal_watches WHERE watch_id = ?", watchId);
  }

  markFailed(watchId: string, error: string): void {
    this.sql.exec(
      `UPDATE signal_watches
         SET status = 'failed', error = ?, updated_at = ?
       WHERE watch_id = ?`,
      error,
      Date.now(),
      watchId,
    );
  }

  removeById(uid: number, target: SignalWatchTargetInput, watchId: string): number {
    if (target.kind === "app") {
      const count = [...this.sql.exec<{ count: number }>(
        `SELECT COUNT(*) as count FROM signal_watches
         WHERE uid = ? AND target_type = 'app' AND package_id = ? AND entrypoint_name = ? AND watch_id = ?`,
        uid,
        target.packageId,
        target.entrypointName,
        watchId,
      )][0]?.count ?? 0;
      if (count > 0) {
        this.sql.exec(
          "DELETE FROM signal_watches WHERE uid = ? AND target_type = 'app' AND package_id = ? AND entrypoint_name = ? AND watch_id = ?",
          uid,
          target.packageId,
          target.entrypointName,
          watchId,
        );
      }
      return count;
    }

    const count = [...this.sql.exec<{ count: number }>(
      `SELECT COUNT(*) as count FROM signal_watches
       WHERE uid = ? AND target_type = 'process' AND target_process_id = ? AND watch_id = ?`,
      uid,
      target.processId,
      watchId,
    )][0]?.count ?? 0;
    if (count > 0) {
      this.sql.exec(
        "DELETE FROM signal_watches WHERE uid = ? AND target_type = 'process' AND target_process_id = ? AND watch_id = ?",
        uid,
        target.processId,
        watchId,
      );
    }
    return count;
  }

  removeByKey(uid: number, target: SignalWatchTargetInput, key: string): number {
    if (target.kind === "app") {
      const count = [...this.sql.exec<{ count: number }>(
        `SELECT COUNT(*) as count FROM signal_watches
         WHERE uid = ? AND target_type = 'app' AND package_id = ? AND entrypoint_name = ? AND dedupe_key = ?`,
        uid,
        target.packageId,
        target.entrypointName,
        key,
      )][0]?.count ?? 0;
      if (count > 0) {
        this.sql.exec(
          "DELETE FROM signal_watches WHERE uid = ? AND target_type = 'app' AND package_id = ? AND entrypoint_name = ? AND dedupe_key = ?",
          uid,
          target.packageId,
          target.entrypointName,
          key,
        );
      }
      return count;
    }

    const count = [...this.sql.exec<{ count: number }>(
      `SELECT COUNT(*) as count FROM signal_watches
       WHERE uid = ? AND target_type = 'process' AND target_process_id = ? AND dedupe_key = ?`,
      uid,
      target.processId,
      key,
    )][0]?.count ?? 0;
    if (count > 0) {
      this.sql.exec(
        "DELETE FROM signal_watches WHERE uid = ? AND target_type = 'process' AND target_process_id = ? AND dedupe_key = ?",
        uid,
        target.processId,
        key,
      );
    }
    return count;
  }

  private findActiveByKey(
    uid: number,
    target: SignalWatchTargetInput,
    key: string,
  ): SignalWatchRecord | null {
    const rows = target.kind === "app"
      ? [...this.sql.exec<RowShape>(
        `SELECT * FROM signal_watches
         WHERE uid = ?
           AND target_type = 'app'
           AND package_id = ?
           AND entrypoint_name = ?
           AND dedupe_key = ?
           AND status = 'active'
         ORDER BY created_at DESC
         LIMIT 1`,
        uid,
        target.packageId,
        target.entrypointName,
        key,
      )]
      : [...this.sql.exec<RowShape>(
        `SELECT * FROM signal_watches
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

  private ensureColumn(table: string, column: string, statement: string): void {
    const rows = [...this.sql.exec<{ name: string }>(`PRAGMA table_info(${table})`)];
    if (!rows.some((row) => row.name === column)) {
      this.sql.exec(statement);
    }
  }
}

type RowShape = {
  watch_id: string;
  uid: number;
  target_type: SignalWatchTargetKind | null;
  target_process_id: string | null;
  package_id: string;
  package_name: string;
  entrypoint_name: string;
  route_base: string;
  signal: string;
  process_id: string | null;
  dedupe_key: string | null;
  state_json: string | null;
  once_only: number;
  status: SignalWatchStatus;
  error: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
};

function toSignalWatchRecord(row: RowShape): SignalWatchRecord {
  const targetKind = row.target_type === "process" ? "process" : "app";
  return {
    watchId: row.watch_id,
    uid: row.uid,
    targetKind,
    targetProcessId: row.target_process_id,
    packageId: row.package_id ? row.package_id : null,
    packageName: row.package_name ? row.package_name : null,
    entrypointName: row.entrypoint_name ? row.entrypoint_name : null,
    routeBase: row.route_base ? row.route_base : null,
    signal: row.signal,
    processId: row.process_id,
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

function parseJsonValue(value: string | null): unknown {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
