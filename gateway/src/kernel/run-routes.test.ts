import { afterEach, describe, expect, it, vi } from "vitest";
import { RunRouteStore } from "./run-routes";

type Row = Record<string, unknown>;

function createMockSql() {
  const table = new Map<string, Row>();

  function exec<T = Row>(query: string, ...bindings: unknown[]) {
    const q = query.trim();

    if (q.startsWith("CREATE TABLE IF NOT EXISTS")) {
      return { toArray: () => [] as T[] };
    }
    if (q.startsWith("CREATE INDEX IF NOT EXISTS")) {
      return { toArray: () => [] as T[] };
    }

    if (q.startsWith("INSERT OR REPLACE INTO run_routes")) {
      const [
        runId,
        routeKind,
        uid,
        connectionId,
        adapter,
        accountId,
        surfaceKind,
        surfaceId,
        threadId,
        createdAt,
        expiresAt,
      ] = bindings as [
        string,
        string,
        number,
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
        uid,
        connection_id: connectionId,
        adapter,
        account_id: accountId,
        surface_kind: surfaceKind,
        surface_id: surfaceId,
        thread_id: threadId,
        created_at: createdAt,
        expires_at: expiresAt,
      });
      return { toArray: () => [] as T[] };
    }

    if (q.startsWith("SELECT COUNT(*) as cnt FROM run_routes WHERE expires_at <= ?")) {
      const [now] = bindings as [number];
      let count = 0;
      for (const row of table.values()) {
        if ((row.expires_at as number) <= now) {
          count += 1;
        }
      }
      return { toArray: () => [{ cnt: count }] as T[] };
    }

    if (q.startsWith("DELETE FROM run_routes WHERE expires_at <= ?")) {
      const [now] = bindings as [number];
      for (const [runId, row] of table.entries()) {
        if ((row.expires_at as number) <= now) {
          table.delete(runId);
        }
      }
      return { toArray: () => [] as T[] };
    }

    if (q.startsWith("SELECT run_id, route_kind, uid, connection_id, adapter, account_id")) {
      const [runId] = bindings as [string];
      const row = table.get(runId);
      return { toArray: () => (row ? [row] : []) as T[] };
    }

    if (q.startsWith("DELETE FROM run_routes WHERE run_id = ?")) {
      const [runId] = bindings as [string];
      table.delete(runId);
      return { toArray: () => [] as T[] };
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
      return { toArray: () => [] as T[] };
    }

    return { toArray: () => [] as T[] };
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
    store.init();

    store.setConnectionRoute("run-1", 1000, "conn-a", 5_000);
    const route = store.get("run-1");

    expect(route).not.toBeNull();
    expect(route?.kind).toBe("connection");
    if (route?.kind === "connection") {
      expect(route.connectionId).toBe("conn-a");
      expect(route.uid).toBe(1000);
      expect(route.expiresAt).toBe(6_000);
    }
  });

  it("stores and resolves adapter routes", () => {
    vi.spyOn(Date, "now").mockReturnValue(2_000);

    const sql = createMockSql();
    const store = new RunRouteStore(sql as unknown as SqlStorage);
    store.init();

    store.setAdapterRoute(
      "run-2",
      1001,
      "whatsapp",
      "default",
      "thread",
      "surface-a",
      "thread-1",
      1_000,
    );

    const route = store.get("run-2");
    expect(route).not.toBeNull();
    expect(route?.kind).toBe("adapter");
    if (route?.kind === "adapter") {
      expect(route.adapter).toBe("whatsapp");
      expect(route.accountId).toBe("default");
      expect(route.surfaceKind).toBe("thread");
      expect(route.threadId).toBe("thread-1");
      expect(route.expiresAt).toBe(3_000);
    }
  });

  it("prunes expired routes", () => {
    vi.spyOn(Date, "now").mockReturnValue(10_000);

    const sql = createMockSql();
    const store = new RunRouteStore(sql as unknown as SqlStorage);
    store.init();

    store.setConnectionRoute("run-expired", 1000, "conn-a", 10);
    expect(store.pruneExpired(10_010)).toBe(1);
    expect(store.get("run-expired")).toBeNull();
  });

  it("clears only connection routes for a connection id", () => {
    vi.spyOn(Date, "now").mockReturnValue(50_000);

    const sql = createMockSql();
    const store = new RunRouteStore(sql as unknown as SqlStorage);
    store.init();

    store.setConnectionRoute("run-c1", 1000, "conn-a");
    store.setConnectionRoute("run-c2", 1000, "conn-b");
    store.setAdapterRoute("run-a1", 1000, "discord", "default", "dm", "dm-1");

    store.clearForConnection("conn-a");

    expect(store.get("run-c1")).toBeNull();
    expect(store.get("run-c2")).not.toBeNull();
    expect(store.get("run-a1")).not.toBeNull();
  });
});
