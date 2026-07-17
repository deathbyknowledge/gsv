import type { AdapterSurfaceKind } from "../adapter-interface";

export type ConnectionRunRoute = {
  kind: "connection";
  runId: string;
  processId: string;
  uid: number;
  connectionId: string;
  createdAt: number;
  expiresAt: number;
};

export type AdapterRunRoute = {
  kind: "adapter";
  runId: string;
  processId: string;
  uid: number;
  adapter: string;
  accountId: string;
  actorId: string;
  surfaceKind: AdapterSurfaceKind;
  surfaceId: string;
  threadId?: string;
  replyToId?: string;
  createdAt: number;
  expiresAt: number;
};

export type RunRoute = ConnectionRunRoute | AdapterRunRoute;

// Reply routes are removed with their terminal run signal. The TTL is only a
// leak guard for processes that disappear without completing cleanup.
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export class RunRouteStore {
  constructor(private readonly sql: SqlStorage) {}

  setConnectionRoute(
    input: {
      runId: string;
      processId: string;
      uid: number;
      connectionId: string;
    },
    ttlMs = DEFAULT_TTL_MS,
  ): ConnectionRunRoute {
    const now = Date.now();
    const expiresAt = now + ttlMs;
    this.upsert({
      ...input,
      routeKind: "connection",
      createdAt: now,
      expiresAt,
    });

    return {
      kind: "connection",
      ...input,
      createdAt: now,
      expiresAt,
    };
  }

  setAdapterRoute(
    input: {
      runId: string;
      processId: string;
      uid: number;
      adapter: string;
      accountId: string;
      actorId: string;
      surfaceKind: AdapterSurfaceKind;
      surfaceId: string;
      threadId?: string;
      replyToId?: string;
    },
    ttlMs = DEFAULT_TTL_MS,
  ): AdapterRunRoute {
    const now = Date.now();
    const expiresAt = now + ttlMs;
    this.upsert({
      ...input,
      routeKind: "adapter",
      threadId: input.threadId ?? null,
      replyToId: input.replyToId ?? null,
      createdAt: now,
      expiresAt,
    });

    return {
      kind: "adapter",
      ...input,
      createdAt: now,
      expiresAt,
    };
  }

  get(runId: string): RunRoute | null {
    this.pruneExpired();

    const rows = this.sql.exec<RowShape>(
      `SELECT run_id, route_kind, process_id, uid, connection_id, adapter, account_id,
              actor_id, surface_kind, surface_id, thread_id, reply_to_id, created_at, expires_at
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

  clearForProcess(processId: string): void {
    this.sql.exec("DELETE FROM run_routes WHERE process_id = ?", processId);
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
    processId: string;
    uid: number;
    connectionId?: string;
    adapter?: string;
    accountId?: string;
    actorId?: string;
    surfaceKind?: string;
    surfaceId?: string;
    threadId?: string | null;
    replyToId?: string | null;
    createdAt: number;
    expiresAt: number;
  }): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO run_routes
       (run_id, route_kind, process_id, uid, connection_id, adapter, account_id, actor_id, surface_kind, surface_id, thread_id, reply_to_id, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.runId,
      input.routeKind,
      input.processId,
      input.uid,
      input.connectionId ?? null,
      input.adapter ?? null,
      input.accountId ?? null,
      input.actorId ?? null,
      input.surfaceKind ?? null,
      input.surfaceId ?? null,
      input.threadId ?? null,
      input.replyToId ?? null,
      input.createdAt,
      input.expiresAt,
    );
  }
}

type RowShape = {
  run_id: string;
  route_kind: string;
  process_id: string | null;
  uid: number;
  connection_id: string | null;
  adapter: string | null;
  account_id: string | null;
  actor_id: string | null;
  surface_kind: string | null;
  surface_id: string | null;
  thread_id: string | null;
  reply_to_id: string | null;
  created_at: number;
  expires_at: number;
};

function toRoute(row: RowShape): RunRoute {
  if (row.route_kind === "adapter") {
    return {
      kind: "adapter",
      runId: row.run_id,
      processId: row.process_id ?? "",
      uid: row.uid,
      adapter: row.adapter ?? "",
      accountId: row.account_id ?? "",
      actorId: row.actor_id ?? "",
      surfaceKind: (row.surface_kind ?? "dm") as AdapterSurfaceKind,
      surfaceId: row.surface_id ?? "",
      threadId: row.thread_id ?? undefined,
      replyToId: row.reply_to_id ?? undefined,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  return {
    kind: "connection",
    runId: row.run_id,
    processId: row.process_id ?? "",
    uid: row.uid,
    connectionId: row.connection_id ?? "",
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}
