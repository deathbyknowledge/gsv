import type { AdapterSurfaceKind } from "../adapter-interface";

export type SurfaceRouteRecord = {
  adapter: string;
  accountId: string;
  actorId: string;
  surfaceKind: AdapterSurfaceKind;
  surfaceId: string;
  threadId?: string;
  uid: number;
  pid: string;
  updatedAt: number;
  updatedByUid: number;
};

export class SurfaceRouteStore {
  constructor(private readonly sql: SqlStorage) {}

  setRoute(input: {
    adapter: string;
    accountId: string;
    actorId: string;
    surfaceKind: AdapterSurfaceKind;
    surfaceId: string;
    threadId?: string;
    uid: number;
    pid: string;
    updatedByUid: number;
  }): SurfaceRouteRecord {
    const now = Date.now();
    const threadId = input.threadId?.trim() || "";
    this.sql.exec(
      `INSERT OR REPLACE INTO surface_routes
       (adapter, account_id, actor_id, surface_kind, surface_id, thread_id, uid, pid, updated_at, updated_by_uid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.adapter,
      input.accountId,
      input.actorId,
      input.surfaceKind,
      input.surfaceId,
      threadId,
      input.uid,
      input.pid,
      now,
      input.updatedByUid,
    );

    return {
      adapter: input.adapter,
      accountId: input.accountId,
      actorId: input.actorId,
      surfaceKind: input.surfaceKind,
      surfaceId: input.surfaceId,
      ...(threadId ? { threadId } : {}),
      uid: input.uid,
      pid: input.pid,
      updatedAt: now,
      updatedByUid: input.updatedByUid,
    };
  }

  clearRoute(input: {
    adapter: string;
    accountId: string;
    actorId: string;
    surfaceKind: AdapterSurfaceKind;
    surfaceId: string;
    threadId?: string;
  }): boolean {
    const existing = this.get(input);
    if (!existing) return false;
    this.sql.exec(
      `DELETE FROM surface_routes
       WHERE adapter = ? AND account_id = ? AND actor_id = ?
         AND surface_kind = ? AND surface_id = ? AND thread_id = ?`,
      input.adapter,
      input.accountId,
      input.actorId,
      input.surfaceKind,
      input.surfaceId,
      input.threadId?.trim() || "",
    );
    return true;
  }

  resolvePid(input: {
    adapter: string;
    accountId: string;
    actorId: string;
    surfaceKind: AdapterSurfaceKind;
    surfaceId: string;
    threadId?: string;
    uid: number;
  }): string | null {
    const rows = this.sql.exec<{ pid: string }>(
      `SELECT pid FROM surface_routes
       WHERE adapter = ? AND account_id = ? AND actor_id = ?
         AND surface_kind = ? AND surface_id = ? AND thread_id = ? AND uid = ?
       LIMIT 1`,
      input.adapter,
      input.accountId,
      input.actorId,
      input.surfaceKind,
      input.surfaceId,
      input.threadId?.trim() || "",
      input.uid,
    ).toArray();
    return rows[0]?.pid ?? null;
  }

  get(input: {
    adapter: string;
    accountId: string;
    actorId: string;
    surfaceKind: AdapterSurfaceKind;
    surfaceId: string;
    threadId?: string;
  }): SurfaceRouteRecord | null {
    const rows = this.sql.exec<RowShape>(
      `SELECT adapter, account_id, actor_id, surface_kind, surface_id, thread_id,
              uid, pid, updated_at, updated_by_uid
       FROM surface_routes
       WHERE adapter = ? AND account_id = ? AND actor_id = ?
         AND surface_kind = ? AND surface_id = ? AND thread_id = ?
       LIMIT 1`,
      input.adapter,
      input.accountId,
      input.actorId,
      input.surfaceKind,
      input.surfaceId,
      input.threadId?.trim() || "",
    ).toArray();
    if (rows.length === 0) return null;
    return toRecord(rows[0]);
  }

  list(uid?: number): SurfaceRouteRecord[] {
    if (typeof uid === "number") {
      return this.sql.exec<RowShape>(
        `SELECT adapter, account_id, actor_id, surface_kind, surface_id, thread_id,
                uid, pid, updated_at, updated_by_uid
         FROM surface_routes
         WHERE uid = ?
         ORDER BY updated_at DESC`,
        uid,
      ).toArray().map(toRecord);
    }

    return this.sql.exec<RowShape>(
      `SELECT adapter, account_id, actor_id, surface_kind, surface_id, thread_id,
              uid, pid, updated_at, updated_by_uid
       FROM surface_routes
       ORDER BY updated_at DESC`,
    ).toArray().map(toRecord);
  }
}

type RowShape = {
  adapter: string;
  account_id: string;
  actor_id: string;
  surface_kind: string;
  surface_id: string;
  thread_id: string;
  uid: number;
  pid: string;
  updated_at: number;
  updated_by_uid: number;
};

function toRecord(row: RowShape): SurfaceRouteRecord {
  return {
    adapter: row.adapter,
    accountId: row.account_id,
    actorId: row.actor_id,
    surfaceKind: row.surface_kind as AdapterSurfaceKind,
    surfaceId: row.surface_id,
    threadId: row.thread_id || undefined,
    uid: row.uid,
    pid: row.pid,
    updatedAt: row.updated_at,
    updatedByUid: row.updated_by_uid,
  };
}
