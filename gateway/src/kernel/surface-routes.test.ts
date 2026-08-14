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
        mode: "surface",
        updatedByUid: 1000,
      });
      store.setRoute({
        ...sharedSurface,
        actorId: "discord:user:bob",
        uid: 2000,
        pid: "proc-bob",
        mode: "surface",
        updatedByUid: 2000,
      });

      expect(
        store.resolvePid({
          ...sharedSurface,
          actorId: "discord:user:alice",
          uid: 1000,
        }),
      ).toBe("proc-alice");
      expect(store.get({
        ...sharedSurface,
        actorId: "discord:user:alice",
      })?.mode).toBe("surface");
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

  it("clears a route only when its pid and mode still match", async () => {
    await runWithRealKernelSql((sql) => {
      const store = new SurfaceRouteStore(sql);
      const key = {
        adapter: "telegram",
        accountId: "bot",
        actorId: "telegram:user:alice",
        surfaceKind: "dm" as const,
        surfaceId: "chat-1",
      };
      store.setRoute({
        ...key,
        uid: 1000,
        pid: "proc-old",
        mode: "legacy",
        updatedByUid: 1000,
      });

      expect(store.clearRouteIfMatches({
        ...key,
        pid: "proc-new",
        mode: "legacy",
      })).toBe(false);
      expect(store.clearRouteIfMatches({
        ...key,
        pid: "proc-old",
        mode: "work",
      })).toBe(false);
      expect(store.resolveRoute({ ...key, uid: 1000 })).toMatchObject({
        pid: "proc-old",
        mode: "legacy",
      });
      expect(store.clearRouteIfMatches({
        ...key,
        pid: "proc-old",
        mode: "legacy",
      })).toBe(true);
      expect(store.resolveRoute({ ...key, uid: 1000 })).toBeNull();
    });
  });

  it("clears only legacy routes for a finished process", async () => {
    await runWithRealKernelSql((sql) => {
      const store = new SurfaceRouteStore(sql);
      const base = {
        adapter: "whatsapp",
        accountId: "primary",
        actorId: "wa:+123",
        uid: 1000,
        pid: "proc-shared",
        updatedByUid: 1000,
      };
      store.setRoute({
        ...base,
        surfaceKind: "dm",
        surfaceId: "dm-legacy",
        mode: "legacy",
      });
      store.setRoute({
        ...base,
        surfaceKind: "dm",
        surfaceId: "dm-work",
        mode: "work",
      });
      store.setRoute({
        ...base,
        surfaceKind: "group",
        surfaceId: "group-1",
        mode: "surface",
      });

      store.clearLegacyForProcess("proc-shared");

      expect(store.list(1000).map(({ surfaceId, mode }) => ({ surfaceId, mode })))
        .toEqual(expect.arrayContaining([
          { surfaceId: "dm-work", mode: "work" },
          { surfaceId: "group-1", mode: "surface" },
        ]));
      expect(store.list(1000).some(({ surfaceId }) => surfaceId === "dm-legacy"))
        .toBe(false);
    });
  });
});
