import { describe, expect, it } from "vitest";
import { identityLinkAllowsSurface } from "./adapter-destinations";
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
});
