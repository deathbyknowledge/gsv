import { afterEach, describe, expect, it, vi } from "vitest";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { RoutingTable } from "./routing";

describe("RoutingTable", () => {
  afterEach(() => vi.restoreAllMocks());

  it("stores the driver connection that received a route", async () => {
    await runWithRealKernelSql((sql) => {
      vi.spyOn(Date, "now").mockReturnValue(1_000);
      const routes = new RoutingTable(sql);

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
  });

  it("fails only routes owned by the disconnected driver connection", async () => {
    await runWithRealKernelSql((sql) => {
      const routes = new RoutingTable(sql);
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
      expect(routes.get("new-request")?.driverConnectionId).toBe(
        "new-connection",
      );
    });
  });
});
