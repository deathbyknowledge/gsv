import type { AdapterAccountStatus } from "../adapter-interface";

export type AdapterStatusRecord = AdapterAccountStatus & {
  adapter: string;
  ownerUid: number | null;
  updatedAt: number;
};

const STATUS_COLUMNS = `adapter, account_id, connected, authenticated, mode,
  last_activity, error, extra_json, owner_uid, updated_at`;

export class AdapterStatusStore {
  private readonly activeLifecycles = new Set<string>();

  constructor(private readonly sql: SqlStorage) {}

  upsert(adapter: string, accountId: string, status: AdapterAccountStatus): AdapterStatusRecord {
    const now = Date.now();
    const rows = this.sql.exec<RowShape>(
      `INSERT INTO adapter_status
       (adapter, account_id, connected, authenticated, mode, last_activity, error, extra_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(adapter, account_id) DO UPDATE SET
         connected = excluded.connected,
         authenticated = excluded.authenticated,
         mode = excluded.mode,
         last_activity = excluded.last_activity,
         error = excluded.error,
         extra_json = excluded.extra_json,
         updated_at = excluded.updated_at
       RETURNING ${STATUS_COLUMNS}`,
      adapter,
      accountId,
      status.connected ? 1 : 0,
      status.authenticated ? 1 : 0,
      status.mode ?? null,
      status.lastActivity ?? null,
      status.error ?? null,
      status.extra ? JSON.stringify(status.extra) : null,
      now,
    ).toArray();
    return toRecord(rows[0]);
  }

  get(adapter: string, accountId: string): AdapterStatusRecord | null {
    const rows = this.sql.exec<RowShape>(
      `SELECT ${STATUS_COLUMNS}
       FROM adapter_status
       WHERE adapter = ? AND account_id = ?
       LIMIT 1`,
      adapter,
      accountId,
    ).toArray();
    return rows[0] ? toRecord(rows[0]) : null;
  }

  setOwner(adapter: string, accountId: string, ownerUid: number): void {
    this.sql.exec(
      `INSERT INTO adapter_status
       (adapter, account_id, connected, authenticated, owner_uid, updated_at)
       VALUES (?, ?, 0, 0, ?, ?)
       ON CONFLICT(adapter, account_id) DO UPDATE SET owner_uid = excluded.owner_uid`,
      adapter,
      accountId,
      ownerUid,
      Date.now(),
    );
  }

  beginLifecycle(adapter: string, accountId: string): void {
    const key = `${adapter}\0${accountId}`;
    if (this.activeLifecycles.has(key)) {
      throw new Error(`Adapter account ${adapter}/${accountId} already has a lifecycle operation`);
    }
    this.activeLifecycles.add(key);
  }

  endLifecycle(adapter: string, accountId: string): void {
    this.activeLifecycles.delete(`${adapter}\0${accountId}`);
  }

  listByOwner(ownerUid: number): AdapterStatusRecord[] {
    return this.sql.exec<RowShape>(
      `SELECT ${STATUS_COLUMNS}
       FROM adapter_status
       WHERE owner_uid = ?
       ORDER BY adapter ASC, updated_at DESC`,
      ownerUid,
    ).toArray().map(toRecord);
  }

  list(adapter: string, accountId?: string): AdapterStatusRecord[] {
    if (accountId) {
      return this.sql.exec<RowShape>(
        `SELECT ${STATUS_COLUMNS}
         FROM adapter_status
         WHERE adapter = ? AND account_id = ?
         ORDER BY updated_at DESC`,
        adapter,
        accountId,
      ).toArray().map(toRecord);
    }

    return this.sql.exec<RowShape>(
      `SELECT ${STATUS_COLUMNS}
       FROM adapter_status
       WHERE adapter = ?
       ORDER BY updated_at DESC`,
      adapter,
    ).toArray().map(toRecord);
  }

  listAll(): AdapterStatusRecord[] {
    return this.sql.exec<RowShape>(
      `SELECT ${STATUS_COLUMNS}
       FROM adapter_status
       ORDER BY adapter ASC, updated_at DESC`,
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
  owner_uid: number | null;
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
    ownerUid: row.owner_uid,
    updatedAt: row.updated_at,
  };
}
