import { afterEach, describe, expect, it, vi } from "vitest";
import { RoutingTable } from "./routing";
import { mockSqlRows, type MockSqlRow } from "../test-support/mock-sql";

function createMockSql() {
  const routes = new Map<string, MockSqlRow>();

  function exec<T = MockSqlRow>(query: string, ...bindings: unknown[]) {
    const normalized = query.trim().replace(/\s+/g, " ");

    if (normalized.startsWith("INSERT OR REPLACE INTO routing_table")) {
      const [
        id,
        call,
        originType,
        originId,
        deviceId,
        driverConnectionId,
        createdAt,
        expiresAt,
        scheduleId,
      ] = bindings as [
        string,
        string,
        string,
        string,
        string,
        string,
        number,
        number,
        string | null,
      ];
      routes.set(id, {
        id,
        call,
        origin_type: originType,
        origin_id: originId,
        device_id: deviceId,
        driver_connection_id: driverConnectionId,
        created_at: createdAt,
        expires_at: expiresAt,
        schedule_id: scheduleId,
      });
      return mockSqlRows<T>();
    }

    if (normalized === "SELECT * FROM routing_table WHERE id = ?") {
      const route = routes.get(bindings[0] as string);
      return mockSqlRows((route ? [route] : []) as T[]);
    }

    if (normalized === "SELECT * FROM routing_table") {
      return mockSqlRows([...routes.values()] as T[]);
    }

    if (normalized.startsWith(
      "SELECT id, origin_type, origin_id, device_id, schedule_id FROM routing_table WHERE driver_connection_id = ?",
    )) {
      const connectionId = bindings[0];
      return mockSqlRows([...routes.values()].filter(
        (route) => route.driver_connection_id === connectionId,
      ) as T[]);
    }

    if (normalized === "DELETE FROM routing_table WHERE driver_connection_id = ?") {
      const connectionId = bindings[0];
      for (const [id, route] of routes) {
        if (route.driver_connection_id === connectionId) {
          routes.delete(id);
        }
      }
      return mockSqlRows<T>();
    }

    if (normalized === "DELETE FROM routing_table WHERE id = ?") {
      routes.delete(bindings[0] as string);
      return mockSqlRows<T>();
    }

    if (
      normalized.startsWith("DELETE FROM routing_table WHERE (origin_type = ? AND origin_id = ?)")
      && normalized.endsWith("RETURNING *")
    ) {
      const origins = new Set<string>();
      for (let index = 0; index < bindings.length; index += 2) {
        origins.add(`${bindings[index] as string}\0${bindings[index + 1] as string}`);
      }
      const removed: MockSqlRow[] = [];
      for (const [id, route] of routes) {
        if (origins.has(`${route.origin_type as string}\0${route.origin_id as string}`)) {
          removed.push(route);
          routes.delete(id);
        }
      }
      return mockSqlRows(removed as T[]);
    }

    if (normalized === "DELETE FROM routing_table") {
      routes.clear();
      return mockSqlRows<T>();
    }

    return mockSqlRows<T>();
  }

  return { exec };
}

describe("RoutingTable", () => {
  afterEach(() => vi.restoreAllMocks());

  it("stores the driver connection that received a route", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const routes = new RoutingTable(createMockSql() as unknown as SqlStorage);

    routes.register(
      "request-1",
      "fs.read",
      { type: "process", id: "process-1" },
      "browser",
      "driver-1",
      { ttlMs: 5_000, scheduleId: "schedule-1" },
    );

    expect(routes.get("request-1")).toEqual({
      id: "request-1",
      call: "fs.read",
      origin: { type: "process", id: "process-1" },
      deviceId: "browser",
      driverConnectionId: "driver-1",
      createdAt: 1_000,
      expiresAt: 6_000,
      scheduleId: "schedule-1",
    });
  });

  it("drains every persisted route for lifecycle fencing", () => {
    const routes = new RoutingTable(createMockSql() as unknown as SqlStorage);
    routes.register(
      "request-1",
      "fs.read",
      { type: "process", id: "process-1" },
      "browser",
      "driver-1",
      { scheduleId: "schedule-1" },
    );
    routes.register(
      "request-2",
      "net.fetch",
      { type: "connection", id: "connection-1" },
      "laptop",
      "driver-2",
    );

    expect(routes.drain()).toEqual([
      expect.objectContaining({
        id: "request-1",
        origin: { type: "process", id: "process-1" },
        scheduleId: "schedule-1",
      }),
      expect.objectContaining({
        id: "request-2",
        origin: { type: "connection", id: "connection-1" },
      }),
    ]);
    expect(routes.get("request-1")).toBeNull();
    expect(routes.get("request-2")).toBeNull();
    expect(routes.drain()).toEqual([]);
  });

  it("atomically drains only routes with an exact origin", () => {
    vi.spyOn(Date, "now").mockReturnValue(2_000);
    const sql = createMockSql();
    const exec = vi.spyOn(sql, "exec");
    const routes = new RoutingTable(sql as unknown as SqlStorage);
    const hostileOriginId = "process-2' OR 1 = 1 --";

    routes.register(
      "request-1",
      "fs.read",
      { type: "process", id: "process-1" },
      "browser",
      "driver-1",
      { ttlMs: 4_000, scheduleId: "schedule-1" },
    );
    routes.register(
      "request-2",
      "net.fetch",
      { type: "process", id: hostileOriginId },
      "laptop",
      "driver-2",
    );
    routes.register(
      "request-3",
      "fs.write",
      { type: "connection", id: "connection-1" },
      "desktop",
      "driver-3",
    );

    expect(routes.drainForOrigins([
      { type: "process", id: "process-1" },
      { type: "process", id: "process-1" },
      { type: "process", id: hostileOriginId },
    ])).toEqual([
      {
        id: "request-1",
        call: "fs.read",
        origin: { type: "process", id: "process-1" },
        deviceId: "browser",
        driverConnectionId: "driver-1",
        createdAt: 2_000,
        expiresAt: 6_000,
        scheduleId: "schedule-1",
      },
      expect.objectContaining({
        id: "request-2",
        origin: { type: "process", id: hostileOriginId },
      }),
    ]);
    expect(routes.get("request-1")).toBeNull();
    expect(routes.get("request-2")).toBeNull();
    expect(routes.get("request-3")).not.toBeNull();

    const deleteCall = exec.mock.calls.find(([query]) => (
      typeof query === "string" && query.includes("RETURNING *")
    ));
    expect(deleteCall?.[0]).not.toContain(hostileOriginId);
    expect(deleteCall?.slice(1)).toEqual([
      "process",
      "process-1",
      "process",
      hostileOriginId,
    ]);
  });

  it("bounds an origin drain before issuing SQL", () => {
    const sql = createMockSql();
    const exec = vi.spyOn(sql, "exec");
    const routes = new RoutingTable(sql as unknown as SqlStorage);
    const origins = Array.from({ length: 257 }, (_, index) => ({
      type: "process" as const,
      id: `process-${index}`,
    }));

    expect(() => routes.drainForOrigins(origins)).toThrow(RangeError);
    expect(exec).not.toHaveBeenCalled();
    expect(routes.drainForOrigins([])).toEqual([]);
    expect(exec).not.toHaveBeenCalled();
  });

  it("fails only routes owned by the disconnected driver connection", () => {
    const routes = new RoutingTable(createMockSql() as unknown as SqlStorage);
    routes.register(
      "old-request",
      "fs.read",
      { type: "process", id: "process-1" },
      "browser",
      "old-connection",
    );
    routes.register(
      "new-request",
      "fs.read",
      { type: "process", id: "process-2" },
      "browser",
      "new-connection",
    );

    expect(routes.failForDriverConnection("old-connection")).toEqual([
      expect.objectContaining({
        id: "old-request",
        deviceId: "browser",
        origin: { type: "process", id: "process-1" },
      }),
    ]);
    expect(routes.get("old-request")).toBeNull();
    expect(routes.get("new-request")?.driverConnectionId).toBe("new-connection");
  });
});
