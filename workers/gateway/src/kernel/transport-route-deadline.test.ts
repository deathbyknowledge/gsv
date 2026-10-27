import { afterEach, describe, expect, it, vi } from "vitest";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import type { Kernel } from "./do";
import { RoutingTable } from "./routing";
import { Transport } from "./transport";

describe("routed request deadlines", () => {
  afterEach(() => vi.restoreAllMocks());

  it("waits for the answer only once an upload has been sent", async () => {
    await runWithRealKernelSql(async (sql) => {
      let scheduled = 0;
      const schedule = vi.fn(async () => ({ id: `schedule-${++scheduled}` }));
      const cancelSchedule = vi.fn(async () => {});
      // SAFETY: route expiry touches only the routing table and the scheduler.
      const host = {} as Kernel;
      Object.assign(host, { routes: new RoutingTable(sql), schedule, cancelSchedule });
      const transport = new Transport(host);
      vi.spyOn(Date, "now").mockReturnValue(1_000);

      const route = await transport.registerRouteWithExpiry({
        id: "upload",
        call: "fs.transfer.receive",
        origin: { type: "connection", id: "client" },
        targetId: "laptop",
        peerConnectionId: "laptop-connection",
        ttlMs: 120_000,
      });
      let finishUpload!: () => void;
      route.attachBody({
        cancel: vi.fn(async () => {}),
        sent: new Promise<void>((resolve) => { finishUpload = resolve; }),
      });

      await vi.waitFor(() => expect(cancelSchedule).toHaveBeenCalledWith("schedule-1"));
      expect(host.routes.get("upload")?.expiresAt).toBeGreaterThan(1_000 + 60 * 60_000);

      vi.mocked(Date.now).mockReturnValue(900_000);
      finishUpload();

      await vi.waitFor(() => expect(cancelSchedule).toHaveBeenCalledWith("schedule-2"));
      expect(schedule).toHaveBeenLastCalledWith(120, "onRouteExpired", "upload");
      expect(host.routes.get("upload")).toMatchObject({ expiresAt: 1_020_000, scheduleId: "schedule-3" });
    });
  });

  it("leaves no expiry behind for a route that ends while its upload starts", async () => {
    await runWithRealKernelSql(async (sql) => {
      let scheduled = 0;
      const schedule = vi.fn(async () => ({ id: `schedule-${++scheduled}` }));
      const cancelSchedule = vi.fn(async () => {});
      // SAFETY: route expiry touches only the routing table and the scheduler.
      const host = {} as Kernel;
      Object.assign(host, { routes: new RoutingTable(sql), schedule, cancelSchedule });
      const transport = new Transport(host);

      const route = await transport.registerRouteWithExpiry({
        id: "upload",
        call: "fs.transfer.receive",
        origin: { type: "connection", id: "client" },
        targetId: "laptop",
        peerConnectionId: "laptop-connection",
        ttlMs: 120_000,
      });
      route.attachBody({ cancel: vi.fn(async () => {}), sent: Promise.resolve() });
      host.routes.remove("upload");

      await vi.waitFor(() => expect(cancelSchedule).toHaveBeenCalledWith("schedule-2"));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(schedule).toHaveBeenCalledTimes(2);
      expect(host.routes.get("upload")).toBeNull();
    });
  });
});
