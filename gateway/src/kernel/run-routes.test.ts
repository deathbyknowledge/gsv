import { afterEach, describe, expect, it, vi } from "vitest";
import { RunRouteStore } from "./run-routes";
import {
  handleMockSchemaStatement,
  mockSqlRows,
  type MockSqlRow,
} from "../test-support/mock-sql";

function createMockSql() {
  const table = new Map<string, MockSqlRow>();

  function exec<T = MockSqlRow>(query: string, ...bindings: unknown[]) {
    const q = query.trim();

    const schemaResult = handleMockSchemaStatement<T>(q);
    if (schemaResult) return schemaResult;

    if (q.startsWith("INSERT OR REPLACE INTO run_routes")) {
      const [
        runId,
        routeKind,
        processId,
        uid,
        connectionId,
        adapter,
        accountId,
        actorId,
        surfaceKind,
        surfaceId,
        threadId,
        replyToId,
        createdAt,
        expiresAt,
      ] = bindings as [
        string,
        string,
        string,
        number,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        number,
        number,
      ];

      table.set(runId, {
        run_id: runId,
        route_kind: routeKind,
        process_id: processId,
        uid,
        connection_id: connectionId,
        adapter,
        account_id: accountId,
        actor_id: actorId,
        surface_kind: surfaceKind,
        surface_id: surfaceId,
        thread_id: threadId,
        reply_to_id: replyToId,
        created_at: createdAt,
        expires_at: expiresAt,
      });
      return mockSqlRows<T>();
    }

    if (q.startsWith("SELECT COUNT(*) as cnt FROM run_routes WHERE expires_at <= ?")) {
      const [now] = bindings as [number];
      let count = 0;
      for (const row of table.values()) {
        if ((row.expires_at as number) <= now) {
          count += 1;
        }
      }
      return mockSqlRows([{ cnt: count }] as T[]);
    }

    if (q.startsWith("DELETE FROM run_routes WHERE expires_at <= ?")) {
      const [now] = bindings as [number];
      for (const [runId, row] of table.entries()) {
        if ((row.expires_at as number) <= now) {
          table.delete(runId);
        }
      }
      return mockSqlRows<T>();
    }

    if (q.startsWith("SELECT run_id, route_kind, process_id, uid, connection_id, adapter, account_id")) {
      const [runId] = bindings as [string];
      const row = table.get(runId);
      return mockSqlRows((row ? [row] : []) as T[]);
    }

    if (q.startsWith("DELETE FROM run_routes WHERE run_id = ?")) {
      const [runId] = bindings as [string];
      table.delete(runId);
      return mockSqlRows<T>();
    }

    if (q.startsWith("DELETE FROM run_routes WHERE route_kind = 'connection' AND connection_id = ?")) {
      const [connectionId] = bindings as [string];
      for (const [runId, row] of table.entries()) {
        if (
          row.route_kind === "connection" &&
          row.connection_id === connectionId
        ) {
          table.delete(runId);
        }
      }
      return mockSqlRows<T>();
    }

    if (q.startsWith("DELETE FROM run_routes WHERE process_id = ?")) {
      const [processId] = bindings as [string];
      for (const [runId, row] of table.entries()) {
        if (row.process_id === processId) table.delete(runId);
      }
      return mockSqlRows<T>();
    }

    return mockSqlRows<T>();
  }

  return { exec };
}

describe("RunRouteStore", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stores and resolves connection routes", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);

    const sql = createMockSql();
    const store = new RunRouteStore(sql as unknown as SqlStorage);

    store.setConnectionRoute({
      runId: "run-1",
      processId: "init:1000",
      uid: 1000,
      connectionId: "conn-a",
    }, 5_000);
    const route = store.get("run-1");

    expect(route).not.toBeNull();
    expect(route?.kind).toBe("connection");
    if (route?.kind === "connection") {
      expect(route.connectionId).toBe("conn-a");
      expect(route.processId).toBe("init:1000");
      expect(route.uid).toBe(1000);
      expect(route.expiresAt).toBe(6_000);
    }
  });

  it("stores and resolves adapter routes", () => {
    vi.spyOn(Date, "now").mockReturnValue(2_000);

    const sql = createMockSql();
    const store = new RunRouteStore(sql as unknown as SqlStorage);

    store.setAdapterRoute({
      runId: "run-2",
      processId: "init:1001",
      uid: 1001,
      adapter: "whatsapp",
      accountId: "default",
      actorId: "actor-1",
      surfaceKind: "thread",
      surfaceId: "surface-a",
      threadId: "thread-1",
      replyToId: "message-2",
    }, 1_000);

    const route = store.get("run-2");
    expect(route).not.toBeNull();
    expect(route?.kind).toBe("adapter");
    if (route?.kind === "adapter") {
      expect(route.adapter).toBe("whatsapp");
      expect(route.accountId).toBe("default");
      expect(route.processId).toBe("init:1001");
      expect(route.actorId).toBe("actor-1");
      expect(route.surfaceKind).toBe("thread");
      expect(route.threadId).toBe("thread-1");
      expect(route.replyToId).toBe("message-2");
      expect(route.expiresAt).toBe(3_000);
    }
    store.setAdapterRoute({
      runId: "run-3",
      processId: "init:1001",
      uid: 1001,
      adapter: "whatsapp",
      accountId: "default",
      actorId: "actor-1",
      surfaceKind: "thread",
      surfaceId: "surface-a",
      threadId: "thread-1",
    });
    expect(store.get("run-2")).not.toBeNull();
    expect(store.get("run-3")).not.toBeNull();
  });

  it("prunes expired routes", () => {
    vi.spyOn(Date, "now").mockReturnValue(10_000);

    const sql = createMockSql();
    const store = new RunRouteStore(sql as unknown as SqlStorage);

    store.setConnectionRoute({
      runId: "run-expired",
      processId: "init:1000",
      uid: 1000,
      connectionId: "conn-a",
    }, 10);
    expect(store.pruneExpired(10_010)).toBe(1);
    expect(store.get("run-expired")).toBeNull();
  });

  it("clears only connection routes for a connection id", () => {
    vi.spyOn(Date, "now").mockReturnValue(50_000);

    const sql = createMockSql();
    const store = new RunRouteStore(sql as unknown as SqlStorage);

    store.setConnectionRoute({
      runId: "run-c1",
      processId: "init:1000",
      uid: 1000,
      connectionId: "conn-a",
    });
    store.setConnectionRoute({
      runId: "run-c2",
      processId: "init:1000",
      uid: 1000,
      connectionId: "conn-b",
    });
    store.setAdapterRoute({
      runId: "run-a1",
      processId: "init:1000",
      uid: 1000,
      adapter: "discord",
      accountId: "default",
      actorId: "actor-1",
      surfaceKind: "dm",
      surfaceId: "dm-1",
    });

    store.clearForConnection("conn-a");

    expect(store.get("run-c1")).toBeNull();
    expect(store.get("run-c2")).not.toBeNull();
    expect(store.get("run-a1")).not.toBeNull();
  });

  it("clears active and queued routes for a reset process", () => {
    vi.spyOn(Date, "now").mockReturnValue(60_000);
    const store = new RunRouteStore(createMockSql() as unknown as SqlStorage);
    store.setAdapterRoute({
      runId: "run-a",
      processId: "proc-a",
      uid: 1000,
      adapter: "telegram",
      accountId: "bot",
      actorId: "actor",
      surfaceKind: "dm",
      surfaceId: "chat",
    });
    store.setConnectionRoute({
      runId: "run-b",
      processId: "proc-a",
      uid: 1000,
      connectionId: "conn",
    });
    store.setConnectionRoute({
      runId: "run-c",
      processId: "proc-b",
      uid: 1000,
      connectionId: "conn",
    });

    store.clearForProcess("proc-a");

    expect(store.get("run-a")).toBeNull();
    expect(store.get("run-b")).toBeNull();
    expect(store.get("run-c")).not.toBeNull();
  });
});
