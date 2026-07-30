import { afterEach, describe, expect, it, vi } from "vitest";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { RunRouteStore } from "./run-routes";

describe("RunRouteStore", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stores and resolves connection routes", async () => {
    await runWithRealKernelSql((sql) => {
      vi.spyOn(Date, "now").mockReturnValue(1_000);
      const store = new RunRouteStore(sql);

      store.setConnectionRoute(
        {
          runId: "run-1",
          processId: "init:1000",
          uid: 1000,
          connectionId: "conn-a",
        },
        5_000,
      );
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
  });

  it("stores and resolves adapter routes", async () => {
    await runWithRealKernelSql((sql) => {
      vi.spyOn(Date, "now").mockReturnValue(2_000);
      const store = new RunRouteStore(sql);

      const stored = store.setAdapterRoute(
        {
          runId: "run-2",
          processId: "init:1001",
          uid: 1001,
          destination: {
            kind: "adapter",
            adapter: "whatsapp",
            accountId: "default",
            actorId: "actor-1",
            surface: { kind: "thread", id: "surface-a", threadId: "thread-1" },
          },
          replyToId: "message-2",
        },
        1_000,
      );
      expect(stored.destination).toEqual({
        kind: "adapter",
        adapter: "whatsapp",
        accountId: "default",
        actorId: "actor-1",
        surface: {
          kind: "thread",
          id: "surface-a",
          threadId: "thread-1",
        },
      });

      const route = store.get("run-2");
      expect(route).not.toBeNull();
      expect(route?.kind).toBe("adapter");
      if (route?.kind === "adapter") {
        expect(route.processId).toBe("init:1001");
        expect(route.destination).toEqual(stored.destination);
        expect(route.replyToId).toBe("message-2");
        expect(route.expiresAt).toBe(3_000);
      }
      store.setAdapterRoute({
        runId: "run-3",
        processId: "init:1001",
        uid: 1001,
        destination: {
          kind: "adapter",
          adapter: "whatsapp",
          accountId: "default",
          actorId: "actor-1",
          surface: { kind: "thread", id: "surface-a", threadId: "thread-1" },
        },
      });
      expect(store.get("run-2")).not.toBeNull();
      expect(store.get("run-3")).not.toBeNull();
    });
  });

  it("prunes expired routes", async () => {
    await runWithRealKernelSql((sql) => {
      vi.spyOn(Date, "now").mockReturnValue(10_000);
      const store = new RunRouteStore(sql);

      store.setConnectionRoute(
        {
          runId: "run-expired",
          processId: "init:1000",
          uid: 1000,
          connectionId: "conn-a",
        },
        10,
      );
      expect(store.pruneExpired(10_010)).toBe(1);
      expect(store.get("run-expired")).toBeNull();
    });
  });

  it("clears only connection routes for a connection id", async () => {
    await runWithRealKernelSql((sql) => {
      vi.spyOn(Date, "now").mockReturnValue(50_000);
      const store = new RunRouteStore(sql);

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
        destination: {
          kind: "adapter",
          adapter: "discord",
          accountId: "default",
          actorId: "actor-1",
          surface: { kind: "dm", id: "dm-1" },
        },
      });

      store.clearForConnection("conn-a");

      expect(store.get("run-c1")).toBeNull();
      expect(store.get("run-c2")).not.toBeNull();
      expect(store.get("run-a1")).not.toBeNull();
    });
  });

  it("clears active and queued routes for a reset process", async () => {
    await runWithRealKernelSql((sql) => {
      vi.spyOn(Date, "now").mockReturnValue(60_000);
      const store = new RunRouteStore(sql);
      store.setAdapterRoute({
        runId: "run-a",
        processId: "proc-a",
        uid: 1000,
        destination: {
          kind: "adapter",
          adapter: "telegram",
          accountId: "bot",
          actorId: "actor",
          surface: { kind: "dm", id: "chat" },
        },
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
});
