import type { AdapterSurfaceKind } from "../adapter-interface";
import { z } from "zod";

const surfaceKindSchema = z.enum(["dm", "group", "channel", "thread"]);
const routeModeSchema = z.enum(["legacy", "work", "surface"]);

export type SurfaceRouteMode = "legacy" | "work" | "surface";

export type SurfaceRouteRecord = {
  adapter: string;
  accountId: string;
  actorId: string;
  surfaceKind: AdapterSurfaceKind;
  surfaceId: string;
  threadId?: string;
  uid: number;
  pid: string;
  mode: SurfaceRouteMode;
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
    mode: SurfaceRouteMode;
    updatedByUid: number;
  }): SurfaceRouteRecord {
    const now = Date.now();
    const threadId = input.threadId?.trim() || "";
    this.sql.exec(
      `INSERT OR REPLACE INTO surface_routes
       (adapter, account_id, actor_id, surface_kind, surface_id, thread_id, uid, pid, route_mode, updated_at, updated_by_uid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.adapter,
      input.accountId,
      input.actorId,
      input.surfaceKind,
      input.surfaceId,
      threadId,
      input.uid,
      input.pid,
      input.mode,
      now,
      input.updatedByUid,
    );

    const record: SurfaceRouteRecord = {
      adapter: input.adapter,
      accountId: input.accountId,
      actorId: input.actorId,
      surfaceKind: input.surfaceKind,
      surfaceId: input.surfaceId,
      uid: input.uid,
      pid: input.pid,
      mode: input.mode,
      updatedAt: now,
      updatedByUid: input.updatedByUid,
    };
    if (threadId) record.threadId = threadId;
    return record;
  }

  clearRouteIfMatches(input: {
    adapter: string;
    accountId: string;
    actorId: string;
    surfaceKind: AdapterSurfaceKind;
    surfaceId: string;
    threadId?: string;
    pid: string;
    mode: SurfaceRouteMode;
  }): boolean {
    const cursor = this.sql.exec(
      `DELETE FROM surface_routes
       WHERE adapter = ? AND account_id = ? AND actor_id = ?
         AND surface_kind = ? AND surface_id = ? AND thread_id = ?
         AND pid = ? AND route_mode = ?`,
      input.adapter,
      input.accountId,
      input.actorId,
      input.surfaceKind,
      input.surfaceId,
      input.threadId?.trim() || "",
      input.pid,
      input.mode,
    );
    return cursor.rowsWritten > 0;
  }

  clearLegacyForProcess(processId: string): void {
    this.sql.exec(
      "DELETE FROM surface_routes WHERE pid = ? AND route_mode = 'legacy'",
      processId,
    );
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
    return this.resolveRoute(input)?.pid ?? null;
  }

  resolveRoute(input: {
    adapter: string;
    accountId: string;
    actorId: string;
    surfaceKind: AdapterSurfaceKind;
    surfaceId: string;
    threadId?: string;
    uid: number;
  }): SurfaceRouteRecord | null {
    const route = this.get(input);
    return route?.uid === input.uid ? route : null;
  }

  get(input: {
    adapter: string;
    accountId: string;
    actorId: string;
    surfaceKind: AdapterSurfaceKind;
    surfaceId: string;
    threadId?: string;
  }): SurfaceRouteRecord | null {
    const rows = this.sql.exec<SurfaceRouteRow>(
      `SELECT adapter, account_id, actor_id, surface_kind, surface_id, thread_id,
              uid, pid, route_mode, updated_at, updated_by_uid
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
    if (uid !== undefined) {
      return this.sql.exec<SurfaceRouteRow>(
        `SELECT adapter, account_id, actor_id, surface_kind, surface_id, thread_id,
                uid, pid, route_mode, updated_at, updated_by_uid
         FROM surface_routes
         WHERE uid = ?
         ORDER BY updated_at DESC`,
        uid,
      ).toArray().map(toRecord);
    }

    return this.sql.exec<SurfaceRouteRow>(
      `SELECT adapter, account_id, actor_id, surface_kind, surface_id, thread_id,
              uid, pid, route_mode, updated_at, updated_by_uid
       FROM surface_routes
       ORDER BY updated_at DESC`,
    ).toArray().map(toRecord);
  }
}

type SurfaceRouteRow = {
  adapter: string;
  account_id: string;
  actor_id: string;
  surface_kind: string;
  surface_id: string;
  thread_id: string;
  uid: number;
  pid: string;
  route_mode: string;
  updated_at: number;
  updated_by_uid: number;
};

function toRecord(row: SurfaceRouteRow): SurfaceRouteRecord {
  return {
    adapter: row.adapter,
    accountId: row.account_id,
    actorId: row.actor_id,
    surfaceKind: surfaceKindSchema.parse(row.surface_kind),
    surfaceId: row.surface_id,
    threadId: row.thread_id || undefined,
    uid: row.uid,
    pid: row.pid,
    mode: routeModeSchema.parse(row.route_mode),
    updatedAt: row.updated_at,
    updatedByUid: row.updated_by_uid,
  };
}
