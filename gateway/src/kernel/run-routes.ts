import type {
  AdapterMessageDestination,
  AdapterSurfaceKind,
} from "@humansandmachines/gsv/protocol";

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
  destination: AdapterMessageDestination;
  replyToId?: string;
  routeGeneration?: string;
  createdAt: number;
  expiresAt: number;
};

export type RunRoute = ConnectionRunRoute | AdapterRunRoute;

export type ProcessApprovalRoute =
  | Omit<ConnectionRunRoute, "runId">
  | Omit<AdapterRunRoute, "runId">;

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
      destination: AdapterMessageDestination;
      replyToId?: string;
      routeGeneration?: string;
    },
    ttlMs = DEFAULT_TTL_MS,
  ): AdapterRunRoute {
    const now = Date.now();
    const expiresAt = now + ttlMs;
    const { destination } = input;
    this.upsert({
      runId: input.runId,
      processId: input.processId,
      uid: input.uid,
      routeKind: "adapter",
      adapter: destination.adapter,
      accountId: destination.accountId,
      actorId: destination.actorId,
      surfaceKind: destination.surface.kind,
      surfaceId: destination.surface.id,
      threadId: destination.surface.threadId ?? null,
      replyToId: input.replyToId ?? null,
      routeGeneration: input.routeGeneration ?? null,
      createdAt: now,
      expiresAt,
    });

    const route: AdapterRunRoute = {
      kind: "adapter",
      runId: input.runId,
      processId: input.processId,
      uid: input.uid,
      destination,
      createdAt: now,
      expiresAt,
    };
    if (input.replyToId !== undefined) route.replyToId = input.replyToId;
    if (input.routeGeneration !== undefined) route.routeGeneration = input.routeGeneration;
    return route;
  }

  get(runId: string): RunRoute | null {
    this.pruneExpired();

    const rows = this.sql.exec<RunRouteRow>(
      `SELECT run_id, route_kind, process_id, uid, connection_id, adapter, account_id,
              actor_id, surface_kind, surface_id, thread_id, reply_to_id, route_generation,
              created_at, expires_at
       FROM run_routes
       WHERE run_id = ?
       LIMIT 1`,
      runId,
    ).toArray();

    if (rows.length === 0) return null;
    const row = rows[0];
    return toRoute(row);
  }

  inheritProcessApprovalRoute(input: {
    processId: string;
    uid: number;
    sourceProcessId?: string;
    sourceRunId?: string;
    connectionId?: string;
  }): ProcessApprovalRoute | null {
    this.pruneExpired();
    let source: ProcessApprovalRoute | RunRoute | null = null;

    if (input.sourceRunId) {
      const runRoute = this.get(input.sourceRunId);
      if (
        runRoute
        && runRoute.uid === input.uid
        && (!input.sourceProcessId || runRoute.processId === input.sourceProcessId)
      ) {
        source = runRoute;
      }
    }
    if (!source && input.sourceProcessId) {
      const inherited = this.getProcessApprovalRoute(input.sourceProcessId);
      if (inherited?.uid === input.uid) source = inherited;
    }
    if (!source && input.connectionId) {
      const now = Date.now();
      source = {
        kind: "connection",
        processId: input.processId,
        uid: input.uid,
        connectionId: input.connectionId,
        createdAt: now,
        expiresAt: now + DEFAULT_TTL_MS,
      };
    }
    if (!source) return null;

    return this.setProcessApprovalRoute(input.processId, source);
  }

  getProcessApprovalRoute(processId: string): ProcessApprovalRoute | null {
    this.pruneExpired();
    const rows = this.sql.exec<ProcessApprovalRouteRow>(
      `SELECT process_id, uid, route_kind, connection_id, adapter, account_id,
              actor_id, surface_kind, surface_id, thread_id, reply_to_id,
              route_generation, created_at, expires_at
       FROM process_approval_routes
       WHERE process_id = ?
       LIMIT 1`,
      processId,
    ).toArray();
    return rows.length === 0 ? null : toProcessApprovalRoute(rows[0]);
  }

  materializeProcessApprovalRoute(input: {
    processId: string;
    runId: string;
    uid: number;
  }): RunRoute | null {
    const source = this.getProcessApprovalRoute(input.processId);
    if (!source || source.uid !== input.uid) return null;
    const ttlMs = source.expiresAt - Date.now();
    if (ttlMs <= 0) return null;

    if (source.kind === "connection") {
      return this.setConnectionRoute({
        runId: input.runId,
        processId: input.processId,
        uid: input.uid,
        connectionId: source.connectionId,
      }, ttlMs);
    }
    return this.setAdapterRoute({
      runId: input.runId,
      processId: input.processId,
      uid: input.uid,
      destination: source.destination,
      ...(source.replyToId === undefined ? undefined : { replyToId: source.replyToId }),
      ...(source.routeGeneration === undefined
        ? undefined
        : { routeGeneration: source.routeGeneration }),
    }, ttlMs);
  }

  delete(runId: string): void {
    this.sql.exec("DELETE FROM run_routes WHERE run_id = ?", runId);
  }

  clearForConnection(connectionId: string): void {
    this.sql.exec(
      `DELETE FROM run_routes WHERE route_kind = 'connection' AND connection_id = ?`,
      connectionId,
    );
    this.sql.exec(
      `DELETE FROM process_approval_routes WHERE route_kind = 'connection' AND connection_id = ?`,
      connectionId,
    );
  }

  clearForProcess(processId: string): void {
    this.sql.exec("DELETE FROM run_routes WHERE process_id = ?", processId);
    this.sql.exec("DELETE FROM process_approval_routes WHERE process_id = ?", processId);
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
    const approvalRows = this.sql.exec<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM process_approval_routes WHERE expires_at <= ?",
      now,
    ).toArray();
    const approvalCount = approvalRows[0]?.cnt ?? 0;
    if (approvalCount > 0) {
      this.sql.exec("DELETE FROM process_approval_routes WHERE expires_at <= ?", now);
    }
    return count + approvalCount;
  }

  private setProcessApprovalRoute(
    processId: string,
    source: ProcessApprovalRoute | RunRoute,
  ): ProcessApprovalRoute {
    const now = Date.now();
    const expiresAt = source.expiresAt;
    if (source.kind === "connection") {
      this.upsertProcessApproval({
        processId,
        uid: source.uid,
        routeKind: "connection",
        connectionId: source.connectionId,
        createdAt: now,
        expiresAt,
      });
      return {
        kind: "connection",
        processId,
        uid: source.uid,
        connectionId: source.connectionId,
        createdAt: now,
        expiresAt,
      };
    }

    const destination = source.destination;
    this.upsertProcessApproval({
      processId,
      uid: source.uid,
      routeKind: "adapter",
      adapter: destination.adapter,
      accountId: destination.accountId,
      actorId: destination.actorId,
      surfaceKind: destination.surface.kind,
      surfaceId: destination.surface.id,
      threadId: destination.surface.threadId ?? null,
      replyToId: source.replyToId ?? null,
      routeGeneration: source.routeGeneration ?? null,
      createdAt: now,
      expiresAt,
    });
    return {
      kind: "adapter",
      processId,
      uid: source.uid,
      destination,
      replyToId: source.replyToId,
      routeGeneration: source.routeGeneration,
      createdAt: now,
      expiresAt,
    };
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
    routeGeneration?: string | null;
    createdAt: number;
    expiresAt: number;
  }): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO run_routes
       (run_id, route_kind, process_id, uid, connection_id, adapter, account_id, actor_id, surface_kind, surface_id, thread_id, reply_to_id, route_generation, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      input.routeGeneration ?? null,
      input.createdAt,
      input.expiresAt,
    );
  }

  private upsertProcessApproval(input: {
    processId: string;
    uid: number;
    routeKind: "connection" | "adapter";
    connectionId?: string;
    adapter?: string;
    accountId?: string;
    actorId?: string;
    surfaceKind?: string;
    surfaceId?: string;
    threadId?: string | null;
    replyToId?: string | null;
    routeGeneration?: string | null;
    createdAt: number;
    expiresAt: number;
  }): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO process_approval_routes
       (process_id, uid, route_kind, connection_id, adapter, account_id, actor_id,
        surface_kind, surface_id, thread_id, reply_to_id, route_generation,
        created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.processId,
      input.uid,
      input.routeKind,
      input.connectionId ?? null,
      input.adapter ?? null,
      input.accountId ?? null,
      input.actorId ?? null,
      input.surfaceKind ?? null,
      input.surfaceId ?? null,
      input.threadId ?? null,
      input.replyToId ?? null,
      input.routeGeneration ?? null,
      input.createdAt,
      input.expiresAt,
    );
  }
}

type RunRouteRow = {
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
  route_generation: string | null;
  created_at: number;
  expires_at: number;
};

type ProcessApprovalRouteRow = Omit<RunRouteRow, "run_id" | "process_id"> & {
  process_id: string;
};

function toRoute(row: RunRouteRow): RunRoute {
  if (row.route_kind === "adapter") {
    return {
      kind: "adapter",
      runId: row.run_id,
      processId: row.process_id ?? "",
      uid: row.uid,
      destination: adapterDestinationFromColumns({
        adapter: row.adapter ?? "",
        accountId: row.account_id ?? "",
        actorId: row.actor_id ?? "",
        // SAFETY: surface kinds are constrained by the persisted run-route schema.
        surfaceKind: (row.surface_kind ?? "dm") as AdapterSurfaceKind,
        surfaceId: row.surface_id ?? "",
        threadId: row.thread_id ?? undefined,
      }),
      replyToId: row.reply_to_id ?? undefined,
      routeGeneration: row.route_generation ?? undefined,
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

function toProcessApprovalRoute(row: ProcessApprovalRouteRow): ProcessApprovalRoute {
  if (row.route_kind === "adapter") {
    return {
      kind: "adapter",
      processId: row.process_id,
      uid: row.uid,
      destination: adapterDestinationFromColumns({
        adapter: row.adapter ?? "",
        accountId: row.account_id ?? "",
        actorId: row.actor_id ?? "",
        // SAFETY: surface kinds are constrained by the persisted approval-route schema.
        surfaceKind: (row.surface_kind ?? "dm") as AdapterSurfaceKind,
        surfaceId: row.surface_id ?? "",
        threadId: row.thread_id ?? undefined,
      }),
      replyToId: row.reply_to_id ?? undefined,
      routeGeneration: row.route_generation ?? undefined,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }
  return {
    kind: "connection",
    processId: row.process_id,
    uid: row.uid,
    connectionId: row.connection_id ?? "",
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function adapterDestinationFromColumns(input: {
  adapter: string;
  accountId: string;
  actorId: string;
  surfaceKind: AdapterSurfaceKind;
  surfaceId: string;
  threadId?: string;
}): AdapterMessageDestination {
  const surface: DestinationSurface = {
    kind: input.surfaceKind,
    id: input.surfaceId,
  };
  if (input.threadId !== undefined) surface.threadId = input.threadId;
  return {
    kind: "adapter",
    adapter: input.adapter,
    accountId: input.accountId,
    actorId: input.actorId,
    surface,
  };
}

type DestinationSurface = { kind: AdapterSurfaceKind; id: string; threadId?: string };
