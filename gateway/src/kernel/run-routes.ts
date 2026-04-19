import type { AdapterSurfaceKind } from "../adapter-interface";

export type ConnectionRunRoute = {
  kind: "connection";
  runId: string;
  uid: number;
  connectionId: string;
  createdAt: number;
  expiresAt: number;
};

export type AdapterRunRoute = {
  kind: "adapter";
  runId: string;
  uid: number;
  adapter: string;
  accountId: string;
  surfaceKind: AdapterSurfaceKind;
  surfaceId: string;
  threadId?: string;
  createdAt: number;
  expiresAt: number;
};

export type RunRoute = ConnectionRunRoute | AdapterRunRoute;

const DEFAULT_TTL_MS = 30 * 60 * 1000;

export class RunRouteStore {
  constructor(private readonly sql: SqlStorage) {}

  init(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS run_routes (
        run_id        TEXT PRIMARY KEY,
        route_kind    TEXT NOT NULL,
        uid           INTEGER NOT NULL,
        connection_id TEXT,
        adapter       TEXT,
        account_id    TEXT,
        surface_kind  TEXT,
        surface_id    TEXT,
        thread_id     TEXT,
        created_at    INTEGER NOT NULL,
        expires_at    INTEGER NOT NULL
      )
    `);

    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_run_routes_expires
      ON run_routes(expires_at)
    `);
  }

  setConnectionRoute(runId: string, uid: number, connectionId: string, ttlMs = DEFAULT_TTL_MS): ConnectionRunRoute {
    const now = Date.now();
    const expiresAt = now + ttlMs;
    this.upsert({
      runId,
      routeKind: "connection",
      uid,
      connectionId,
      createdAt: now,
      expiresAt,
    });

    return {
      kind: "connection",
      runId,
      uid,
      connectionId,
      createdAt: now,
      expiresAt,
    };
  }

  setAdapterRoute(
    runId: string,
    uid: number,
    adapter: string,
    accountId: string,
    surfaceKind: AdapterSurfaceKind,
    surfaceId: string,
    threadId?: string,
    ttlMs = DEFAULT_TTL_MS,
  ): AdapterRunRoute {
    const now = Date.now();
    const expiresAt = now + ttlMs;
    this.upsert({
      runId,
      routeKind: "adapter",
      uid,
      adapter,
      accountId,
      surfaceKind,
      surfaceId,
      threadId: threadId ?? null,
      createdAt: now,
      expiresAt,
    });

    return {
      kind: "adapter",
      runId,
      uid,
      adapter,
      accountId,
      surfaceKind,
      surfaceId,
      threadId,
      createdAt: now,
      expiresAt,
    };
  }

  get(runId: string): RunRoute | null {
    this.pruneExpired();

    const rows = this.sql.exec<RowShape>(
      `SELECT run_id, route_kind, uid, connection_id, adapter, account_id,
              surface_kind, surface_id, thread_id, created_at, expires_at
       FROM run_routes
       WHERE run_id = ?
       LIMIT 1`,
      runId,
    ).toArray();

    if (rows.length === 0) return null;
    const row = rows[0];
    return toRoute(row);
  }

  delete(runId: string): void {
    this.sql.exec("DELETE FROM run_routes WHERE run_id = ?", runId);
  }

  clearForConnection(connectionId: string): void {
    this.sql.exec(
      `DELETE FROM run_routes WHERE route_kind = 'connection' AND connection_id = ?`,
      connectionId,
    );
  }

  pruneExpired(now = Date.now()): number {
    const rows = this.sql.exec<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM run_routes WHERE expires_at <= ?",
      now,
    ).toArray();
    const count = rows[0]?.cnt ?? 0;
    if (count > 0) {
      this.sql.exec("DELETE FROM run_routes WHERE expires_at <= ?", now);
    }
    return count;
  }

  private upsert(input: {
    runId: string;
    routeKind: "connection" | "adapter";
    uid: number;
    connectionId?: string;
    adapter?: string;
    accountId?: string;
    surfaceKind?: string;
    surfaceId?: string;
    threadId?: string | null;
    createdAt: number;
    expiresAt: number;
  }): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO run_routes
       (run_id, route_kind, uid, connection_id, adapter, account_id, surface_kind, surface_id, thread_id, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.runId,
      input.routeKind,
      input.uid,
      input.connectionId ?? null,
      input.adapter ?? null,
      input.accountId ?? null,
      input.surfaceKind ?? null,
      input.surfaceId ?? null,
      input.threadId ?? null,
      input.createdAt,
      input.expiresAt,
    );
  }
}

type RowShape = {
  run_id: string;
  route_kind: string;
  uid: number;
  connection_id: string | null;
  adapter: string | null;
  account_id: string | null;
  surface_kind: string | null;
  surface_id: string | null;
  thread_id: string | null;
  created_at: number;
  expires_at: number;
};

function toRoute(row: RowShape): RunRoute {
  if (row.route_kind === "adapter") {
    return {
      kind: "adapter",
      runId: row.run_id,
      uid: row.uid,
      adapter: row.adapter ?? "",
      accountId: row.account_id ?? "",
      surfaceKind: (row.surface_kind ?? "dm") as AdapterSurfaceKind,
      surfaceId: row.surface_id ?? "",
      threadId: row.thread_id ?? undefined,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  return {
    kind: "connection",
    runId: row.run_id,
    uid: row.uid,
    connectionId: row.connection_id ?? "",
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}
