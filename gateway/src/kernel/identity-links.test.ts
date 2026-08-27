import { describe, expect, it } from "vitest";
import {
  identityLinkAllowsSurface,
  identityLinkRouteGeneration,
} from "./adapter-destinations";
import { IdentityLinkStore } from "./identity-links";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";

describe("IdentityLinkStore", () => {
  it("binds a metadata-less manual link to its first authenticated private surface", async () => {
    await runWithRealKernelSql((sql) => {
      const store = new IdentityLinkStore(sql);
      store.link("telegram", "bot", "telegram:user:1", 1000, 0);

      const bound = store.bindSurfaceIfMissing(
        "telegram",
        "bot",
        "telegram:user:1",
        { kind: "dm", id: "chat-1" },
      );

      expect(bound).not.toBeNull();
      expect(identityLinkAllowsSurface(bound!, { kind: "dm", id: "chat-1" })).toBe(true);
      expect(identityLinkAllowsSurface(bound!, { kind: "dm", id: "chat-2" })).toBe(false);
      expect(store.get("telegram", "bot", "telegram:user:1")?.metadata).toEqual({
        surfaceKind: "dm",
        surfaceId: "chat-1",
      });

      const unchanged = store.bindSurfaceIfMissing(
        "telegram",
        "bot",
        "telegram:user:1",
        { kind: "dm", id: "chat-2" },
      );
      expect(unchanged?.metadata).toEqual({
        surfaceKind: "dm",
        surfaceId: "chat-1",
      });
    });
  });

  it("fences an actor-scoped managed route across observed surfaces without authorizing them", () => {
    const link = {
      adapter: "slack",
      accountId: "workspace-1",
      actorId: "U123",
      uid: 1000,
      createdAt: 1,
      linkedByUid: 1000,
      metadata: {
        managed: true,
        surfaceKind: "dm",
        surfaceId: "D123",
        routeScope: "actor",
        routeGeneration: "generation-1",
      },
    };

    expect(identityLinkAllowsSurface(link, { kind: "dm", id: "D123" })).toBe(true);
    expect(identityLinkAllowsSurface(link, { kind: "channel", id: "C123" })).toBe(false);
    expect(identityLinkRouteGeneration(link, { kind: "channel", id: "C123" }))
      .toBe("generation-1");
  });
});
