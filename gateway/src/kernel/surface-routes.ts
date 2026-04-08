import type { AdapterSurfaceKind } from "../adapter-interface";

export type SurfaceRouteRecord = {
  adapter: string;
  accountId: string;
  surfaceKind: AdapterSurfaceKind;
  surfaceId: string;
  uid: number;
  pid: string;
  updatedAt: number;
  updatedByUid: number;
};

export class SurfaceRouteStore {
  constructor(private readonly sql: SqlStorage) {}

  init(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS surface_routes (
        adapter        TEXT NOT NULL,
        account_id     TEXT NOT NULL,
        surface_kind   TEXT NOT NULL,
        surface_id     TEXT NOT NULL,
        uid            INTEGER NOT NULL,
        pid            TEXT NOT NULL,
        updated_at     INTEGER NOT NULL,
        updated_by_uid INTEGER NOT NULL,
        PRIMARY KEY (adapter, account_id, surface_kind, surface_id)
      )
    `);

    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_surface_routes_uid
      ON surface_routes(uid)
    `);
  }

  setRoute(
    adapter: string,
    accountId: string,
    surfaceKind: AdapterSurfaceKind,
    surfaceId: string,
    uid: number,
    pid: string,
    updatedByUid: number,
  ): SurfaceRouteRecord {
    const now = Date.now();
    this.sql.exec(
      `INSERT OR REPLACE INTO surface_routes
       (adapter, account_id, surface_kind, surface_id, uid, pid, updated_at, updated_by_uid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      adapter,
      accountId,
      surfaceKind,
      surfaceId,
      uid,
      pid,
      now,
      updatedByUid,
    );

    return {
      adapter,
      accountId,
      surfaceKind,
      surfaceId,
      uid,
      pid,
      updatedAt: now,
      updatedByUid,
    };
  }

  clearRoute(
    adapter: string,
    accountId: string,
    surfaceKind: AdapterSurfaceKind,
    surfaceId: string,
  ): boolean {
    const existing = this.get(adapter, accountId, surfaceKind, surfaceId);
    if (!existing) return false;
    this.sql.exec(
      `DELETE FROM surface_routes WHERE adapter = ? AND account_id = ? AND surface_kind = ? AND surface_id = ?`,
      adapter,
      accountId,
      surfaceKind,
      surfaceId,
    );
    return true;
  }

  resolvePid(
    adapter: string,
    accountId: string,
    surfaceKind: AdapterSurfaceKind,
    surfaceId: string,
    uid: number,
  ): string | null {
    const rows = this.sql.exec<{ pid: string }>(
      `SELECT pid FROM surface_routes
       WHERE adapter = ? AND account_id = ? AND surface_kind = ? AND surface_id = ? AND uid = ?
       LIMIT 1`,
      adapter,
      accountId,
      surfaceKind,
      surfaceId,
      uid,
    ).toArray();
    return rows[0]?.pid ?? null;
  }

  get(
    adapter: string,
    accountId: string,
    surfaceKind: AdapterSurfaceKind,
    surfaceId: string,
  ): SurfaceRouteRecord | null {
    const rows = this.sql.exec<RowShape>(
      `SELECT adapter, account_id, surface_kind, surface_id, uid, pid, updated_at, updated_by_uid
       FROM surface_routes
       WHERE adapter = ? AND account_id = ? AND surface_kind = ? AND surface_id = ?
       LIMIT 1`,
      adapter,
      accountId,
      surfaceKind,
      surfaceId,
    ).toArray();
    if (rows.length === 0) return null;
    return toRecord(rows[0]);
  }

  list(uid?: number): SurfaceRouteRecord[] {
    if (typeof uid === "number") {
      return this.sql.exec<RowShape>(
        `SELECT adapter, account_id, surface_kind, surface_id, uid, pid, updated_at, updated_by_uid
         FROM surface_routes
         WHERE uid = ?
         ORDER BY updated_at DESC`,
        uid,
      ).toArray().map(toRecord);
    }

    return this.sql.exec<RowShape>(
      `SELECT adapter, account_id, surface_kind, surface_id, uid, pid, updated_at, updated_by_uid
       FROM surface_routes
       ORDER BY updated_at DESC`,
    ).toArray().map(toRecord);
  }
}

type RowShape = {
  adapter: string;
  account_id: string;
  surface_kind: string;
  surface_id: string;
  uid: number;
  pid: string;
  updated_at: number;
  updated_by_uid: number;
};

function toRecord(row: RowShape): SurfaceRouteRecord {
  return {
    adapter: row.adapter,
    accountId: row.account_id,
    surfaceKind: row.surface_kind as AdapterSurfaceKind,
    surfaceId: row.surface_id,
    uid: row.uid,
    pid: row.pid,
    updatedAt: row.updated_at,
    updatedByUid: row.updated_by_uid,
  };
}
