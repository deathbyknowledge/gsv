import type { AdapterAccountStatus } from "../adapter-interface";
import type { AdapterMetadata } from "@humansandmachines/gsv/protocol";
import { adapterMetadataSchema } from "@humansandmachines/gsv/protocol";

export type AdapterStatusRecord = AdapterAccountStatus & {
  adapter: string;
  lifecycleId: string;
  readyOwnerUid: number | null;
  ownerUid: number | null;
  updatedAt: number;
};

const STATUS_COLUMNS = `adapter, account_id, connected, authenticated, mode,
  last_activity, error, extra_json, lifecycle_id, ready_owner_uid, owner_uid, updated_at`;

export class AdapterStatusStore {
  private readonly activeLifecycles = new Set<string>();

  constructor(private readonly sql: SqlStorage) {}

  upsert(adapter: string, accountId: string, status: AdapterAccountStatus): AdapterStatusRecord {
    const now = Date.now();
    const lifecycleId = `adapter-account:${crypto.randomUUID()}`;
    const rows = this.sql.exec<AdapterStatusRow>(
      `INSERT INTO adapter_status
       (adapter, account_id, connected, authenticated, mode, last_activity, error,
        extra_json, lifecycle_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(adapter, account_id) DO UPDATE SET
         connected = excluded.connected,
         authenticated = excluded.authenticated,
         mode = excluded.mode,
         last_activity = excluded.last_activity,
         error = excluded.error,
         extra_json = excluded.extra_json,
         lifecycle_id = COALESCE(adapter_status.lifecycle_id, excluded.lifecycle_id),
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
      lifecycleId,
      now,
    ).toArray();
    return toRecord(rows[0]);
  }

  get(adapter: string, accountId: string): AdapterStatusRecord | null {
    const rows = this.sql.exec<AdapterStatusRow>(
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
    const lifecycleId = `adapter-account:${crypto.randomUUID()}`;
    this.sql.exec(
      `INSERT INTO adapter_status
       (adapter, account_id, connected, authenticated, lifecycle_id, owner_uid, updated_at)
       VALUES (?, ?, 0, 0, ?, ?, ?)
       ON CONFLICT(adapter, account_id) DO UPDATE SET
         lifecycle_id = COALESCE(adapter_status.lifecycle_id, excluded.lifecycle_id),
         owner_uid = excluded.owner_uid`,
      adapter,
      accountId,
      lifecycleId,
      ownerUid,
      Date.now(),
    );
  }

  markReadyForOwner(adapter: string, accountId: string, ownerUid: number): void {
    const cursor = this.sql.exec(
      `UPDATE adapter_status
       SET ready_owner_uid = ?
       WHERE adapter = ? AND account_id = ? AND owner_uid = ?
         AND connected = 1 AND authenticated = 1`,
      ownerUid,
      adapter,
      accountId,
      ownerUid,
    );
    if (cursor.rowsWritten !== 1) {
      throw new Error(`Adapter account ${adapter}/${accountId} readiness changed`);
    }
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

  isLifecycleActive(adapter: string, accountId: string): boolean {
    return this.activeLifecycles.has(`${adapter}\0${accountId}`);
  }

  listByOwner(ownerUid: number): AdapterStatusRecord[] {
    return this.sql.exec<AdapterStatusRow>(
      `SELECT ${STATUS_COLUMNS}
       FROM adapter_status
       WHERE owner_uid = ?
       ORDER BY adapter ASC, updated_at DESC`,
      ownerUid,
    ).toArray().map(toRecord);
  }

  list(adapter: string, accountId?: string): AdapterStatusRecord[] {
    if (accountId) {
      return this.sql.exec<AdapterStatusRow>(
        `SELECT ${STATUS_COLUMNS}
         FROM adapter_status
         WHERE adapter = ? AND account_id = ?
         ORDER BY updated_at DESC`,
        adapter,
        accountId,
      ).toArray().map(toRecord);
    }

    return this.sql.exec<AdapterStatusRow>(
      `SELECT ${STATUS_COLUMNS}
       FROM adapter_status
       WHERE adapter = ?
       ORDER BY updated_at DESC`,
      adapter,
    ).toArray().map(toRecord);
  }

  listAll(): AdapterStatusRecord[] {
    return this.sql.exec<AdapterStatusRow>(
      `SELECT ${STATUS_COLUMNS}
       FROM adapter_status
       ORDER BY adapter ASC, updated_at DESC`,
    ).toArray().map(toRecord);
  }
}

type AdapterStatusRow = {
  adapter: string;
  account_id: string;
  connected: number;
  authenticated: number;
  mode: string | null;
  last_activity: number | null;
  error: string | null;
  extra_json: string | null;
  lifecycle_id: string | null;
  ready_owner_uid: number | null;
  owner_uid: number | null;
  updated_at: number;
};

function toRecord(row: AdapterStatusRow): AdapterStatusRecord {
  if (!row.lifecycle_id) throw new Error("Adapter status is missing its lifecycle identity");
  return {
    adapter: row.adapter,
    lifecycleId: row.lifecycle_id,
    readyOwnerUid: row.ready_owner_uid,
    accountId: row.account_id,
    connected: row.connected === 1,
    authenticated: row.authenticated === 1,
    mode: row.mode ?? undefined,
    lastActivity: row.last_activity ?? undefined,
    error: row.error ?? undefined,
    extra: parseAdapterStatusExtra(row.extra_json),
    ownerUid: row.owner_uid,
    updatedAt: row.updated_at,
  };
}

function parseAdapterStatusExtra(source: string | null): AdapterMetadata | undefined {
  if (source === null) return undefined;
  const decoded = adapterMetadataSchema.safeParse(JSON.parse(source));
  if (!decoded.success) throw new Error("Stored adapter status metadata is invalid");
  return decoded.data;
}
