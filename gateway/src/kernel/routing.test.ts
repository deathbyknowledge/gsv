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
