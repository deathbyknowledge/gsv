import type { AdapterAccountStatus } from "../adapter-interface";
import { normalizeAdapterAccountId } from "@humansandmachines/gsv/protocol";

export type AdapterStatusRecord = AdapterAccountStatus & {
  adapter: string;
  ownerUid: number | null;
  updatedAt: number;
};

export type InvalidAdapterAccountCleanup = {
  removed: number;
  blocked: number;
};

const STATUS_COLUMNS = `adapter, account_id, connected, authenticated, mode,
  last_activity, error, extra_json, owner_uid, updated_at`;

export class AdapterStatusStore {
  private readonly activeLifecycles = new Set<string>();

  constructor(private readonly sql: SqlStorage) {}

  upsert(adapter: string, accountId: string, status: AdapterAccountStatus): AdapterStatusRecord {
    const normalizedAccountId = requireAdapterAccountId(accountId);
    if (normalizeAdapterAccountId(status.accountId) !== normalizedAccountId) {
      throw new Error("Adapter status account ID does not match its storage identity");
    }
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
      normalizedAccountId,
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
    const normalizedAccountId = requireAdapterAccountId(accountId);
    this.sql.exec(
      `INSERT INTO adapter_status
       (adapter, account_id, connected, authenticated, owner_uid, updated_at)
       VALUES (?, ?, 0, 0, ?, ?)
       ON CONFLICT(adapter, account_id) DO UPDATE SET owner_uid = excluded.owner_uid`,
      adapter,
      normalizedAccountId,
      ownerUid,
      Date.now(),
    );
  }

  beginLifecycle(adapter: string, accountId: string): void {
    const normalizedAccountId = requireAdapterAccountId(accountId);
    const key = `${adapter}\0${normalizedAccountId}`;
    if (this.activeLifecycles.has(key)) {
      throw new Error(`Adapter account ${adapter}/${accountId} already has a lifecycle operation`);
    }
    this.activeLifecycles.add(key);
  }

  endLifecycle(adapter: string, accountId: string): void {
    const normalizedAccountId = normalizeAdapterAccountId(accountId);
    if (normalizedAccountId) {
      this.activeLifecycles.delete(`${adapter}\0${normalizedAccountId}`);
    }
  }

  /**
   * Removes only historical invalid rows that have the exact shape of an
   * owner claim which never reached a connected/authenticated status and has
   * no identity, route, challenge, or run references. Anything else may own a
   * live adapter Durable Object and must block lifecycle enumeration.
   */
  cleanupInvalidManagedAccounts(managedAdapters: readonly string[]): InvalidAdapterAccountCleanup {
    const managed = new Set(managedAdapters.map((adapter) => adapter.trim().toLowerCase()));
    const rows = this.sql.exec<InvalidAccountRow>(
      `SELECT adapter, account_id, connected, authenticated, mode,
              last_activity, error, extra_json
       FROM adapter_status`,
    ).toArray();
    let removed = 0;
    let blocked = 0;
    for (const row of rows) {
      const normalizedAdapter = row.adapter.trim().toLowerCase();
      if (
        !managed.has(normalizedAdapter)
        || normalizeAdapterAccountId(row.account_id) !== null
      ) {
        continue;
      }
      const pristine = row.connected === 0
        && row.authenticated === 0
        && row.mode === null
        && row.last_activity === null
        && row.error === null
        && row.extra_json === null
        && !this.hasAccountReferences(row.adapter, row.account_id)
        && !this.activeLifecycles.has(`${row.adapter}\0${row.account_id}`);
      if (!pristine) {
        blocked += 1;
        continue;
      }
      this.sql.exec(
        `DELETE FROM adapter_status WHERE adapter = ? AND account_id = ?`,
        row.adapter,
        row.account_id,
      );
      removed += 1;
    }
    return { removed, blocked };
  }

  private hasAccountReferences(adapter: string, accountId: string): boolean {
    const row = this.sql.exec<{ found: number }>(
      `SELECT EXISTS (
         SELECT 1 FROM identity_links WHERE adapter = ? AND account_id = ?
         UNION ALL
         SELECT 1 FROM surface_routes WHERE adapter = ? AND account_id = ?
         UNION ALL
         SELECT 1 FROM link_challenges WHERE adapter = ? AND account_id = ?
         UNION ALL
         SELECT 1 FROM run_routes WHERE adapter = ? AND account_id = ?
       ) AS found`,
      adapter,
      accountId,
      adapter,
      accountId,
      adapter,
      accountId,
      adapter,
      accountId,
    ).toArray()[0];
    return row?.found === 1;
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

type InvalidAccountRow = Pick<
  RowShape,
  | "adapter"
  | "account_id"
  | "connected"
  | "authenticated"
  | "mode"
  | "last_activity"
  | "error"
  | "extra_json"
>;

function requireAdapterAccountId(accountId: unknown): string {
  const normalized = normalizeAdapterAccountId(accountId);
  if (!normalized) {
    throw new Error("Adapter account ID is invalid");
  }
  return normalized;
}

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
