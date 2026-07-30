import { afterEach, describe, expect, it, vi } from "vitest";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { SurfaceRouteStore } from "./surface-routes";

describe("SurfaceRouteStore", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps routes actor-scoped when multiple users share a group surface", async () => {
    await runWithRealKernelSql((sql) => {
      vi.spyOn(Date, "now").mockReturnValue(1_000);
      const store = new SurfaceRouteStore(sql);
      const sharedSurface = {
        adapter: "discord",
        accountId: "bot",
        surfaceKind: "group" as const,
        surfaceId: "channel-1",
      };

      store.setRoute({
        ...sharedSurface,
        actorId: "discord:user:alice",
        uid: 1000,
        pid: "proc-alice",
        updatedByUid: 1000,
      });
      store.setRoute({
        ...sharedSurface,
        actorId: "discord:user:bob",
        uid: 2000,
        pid: "proc-bob",
        updatedByUid: 2000,
      });

      expect(
        store.resolvePid({
          ...sharedSurface,
          actorId: "discord:user:alice",
          uid: 1000,
        }),
      ).toBe("proc-alice");
      expect(
        store.resolvePid({
          ...sharedSurface,
          actorId: "discord:user:bob",
          uid: 2000,
        }),
      ).toBe("proc-bob");
      expect(
        store.resolvePid({
          ...sharedSurface,
          actorId: "discord:user:alice",
          uid: 2000,
        }),
      ).toBeNull();
      expect(
        store.get({
          ...sharedSurface,
          actorId: "discord:user:alice",
        })?.pid,
      ).toBe("proc-alice");
    });
  });
});
