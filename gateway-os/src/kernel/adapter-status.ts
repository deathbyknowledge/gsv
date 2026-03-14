import type { AdapterAccountStatus } from "../adapter-interface";

export type AdapterStatusRecord = AdapterAccountStatus & {
  adapter: string;
  updatedAt: number;
};

export class AdapterStatusStore {
  constructor(private readonly sql: SqlStorage) {}

  init(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS adapter_status (
        adapter        TEXT NOT NULL,
        account_id     TEXT NOT NULL,
        connected      INTEGER NOT NULL,
        authenticated  INTEGER NOT NULL,
        mode           TEXT,
        last_activity  INTEGER,
        error          TEXT,
        extra_json     TEXT,
        updated_at     INTEGER NOT NULL,
        PRIMARY KEY (adapter, account_id)
      )
    `);

    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_adapter_status_adapter
      ON adapter_status(adapter)
    `);
  }

  upsert(adapter: string, accountId: string, status: AdapterAccountStatus): AdapterStatusRecord {
    const now = Date.now();
    this.sql.exec(
      `INSERT OR REPLACE INTO adapter_status
       (adapter, account_id, connected, authenticated, mode, last_activity, error, extra_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      adapter,
      accountId,
      status.connected ? 1 : 0,
      status.authenticated ? 1 : 0,
      status.mode ?? null,
      status.lastActivity ?? null,
      status.error ?? null,
      status.extra ? JSON.stringify(status.extra) : null,
      now,
    );

    return {
      adapter,
      accountId,
      connected: status.connected,
      authenticated: status.authenticated,
      mode: status.mode,
      lastActivity: status.lastActivity,
      error: status.error,
      extra: status.extra,
      updatedAt: now,
    };
  }

  list(adapter: string, accountId?: string): AdapterStatusRecord[] {
    if (accountId) {
      return this.sql.exec<RowShape>(
        `SELECT adapter, account_id, connected, authenticated, mode, last_activity, error, extra_json, updated_at
         FROM adapter_status
         WHERE adapter = ? AND account_id = ?
         ORDER BY updated_at DESC`,
        adapter,
        accountId,
      ).toArray().map(toRecord);
    }

    return this.sql.exec<RowShape>(
      `SELECT adapter, account_id, connected, authenticated, mode, last_activity, error, extra_json, updated_at
       FROM adapter_status
       WHERE adapter = ?
       ORDER BY updated_at DESC`,
      adapter,
    ).toArray().map(toRecord);
  }
}

type RowShape = {
  adapter: string;
  account_id: string;
  connected: number;
  authenticated: number;
  mode: string | null;
  last_activity: number | null;
  error: string | null;
  extra_json: string | null;
  updated_at: number;
};

function toRecord(row: RowShape): AdapterStatusRecord {
  return {
    adapter: row.adapter,
    accountId: row.account_id,
    connected: row.connected === 1,
    authenticated: row.authenticated === 1,
    mode: row.mode ?? undefined,
    lastActivity: row.last_activity ?? undefined,
    error: row.error ?? undefined,
    extra: row.extra_json
      ? (JSON.parse(row.extra_json) as Record<string, unknown>)
      : undefined,
    updatedAt: row.updated_at,
  };
}
