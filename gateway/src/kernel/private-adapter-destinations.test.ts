import { afterEach, describe, expect, it, vi } from "vitest";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { PrivateAdapterDestinationStore } from "./private-adapter-destinations";

describe("PrivateAdapterDestinationStore", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps only the owner's last-active private destination", async () => {
    await runWithRealKernelSql((sql) => {
      const store = new PrivateAdapterDestinationStore(sql);
      const whatsapp = {
        kind: "adapter" as const,
        adapter: "whatsapp",
        accountId: "primary",
        actorId: "wa:+123",
        surface: { kind: "dm" as const, id: "dm-1" },
      };
      const telegram = {
        kind: "adapter" as const,
        adapter: "telegram",
        accountId: "bot",
        actorId: "telegram:user:123",
        surface: { kind: "dm" as const, id: "chat-2" },
      };

      store.recordActivity(1000, whatsapp, "wa-1", 100);
      store.recordActivity(1000, telegram, "tg-1", 200);
      store.recordActivity(1000, whatsapp, "wa-stale", 100);
      store.recordActivity(1000, telegram, "tg-2", 200);

      expect(store.get(1000)).toEqual({
        uid: 1000,
        destination: telegram,
        messageId: "tg-2",
        updatedAt: 200,
      });
      expect(store.get(2000)).toBeNull();
    });
  });

  it("conditionally clears a revoked destination without erasing a newer one", async () => {
    await runWithRealKernelSql((sql) => {
      const store = new PrivateAdapterDestinationStore(sql);
      const destination = {
        kind: "adapter" as const,
        adapter: "telegram",
        accountId: "bot",
        actorId: "telegram:user:123",
        surface: { kind: "dm" as const, id: "chat-2" },
      };
      store.recordActivity(1000, destination, "tg-1", 100);

      expect(store.clearIfMatches(1000, {
        ...destination,
        surface: { kind: "dm", id: "other" },
      })).toBe(false);
      expect(store.get(1000)).not.toBeNull();
      expect(store.clearIfMatches(1000, destination)).toBe(true);
      expect(store.get(1000)).toBeNull();
    });
  });

  it("rejects non-private activity", async () => {
    await runWithRealKernelSql((sql) => {
      const store = new PrivateAdapterDestinationStore(sql);
      expect(() => store.recordActivity(1000, {
        kind: "adapter",
        adapter: "discord",
        accountId: "bot",
        actorId: "discord:user:1",
        surface: { kind: "group", id: "group-1" },
      }, "discord-1", 100)).toThrow("must be a DM");
      expect(() => store.recordActivity(1000, {
        kind: "adapter",
        adapter: "telegram",
        accountId: "bot",
        actorId: "telegram:user:1",
        surface: { kind: "dm", id: "chat-1" },
      }, "telegram-1", Number.NaN)).toThrow("timestamp must be a positive integer");
      expect(() => store.recordActivity(1000, {
        kind: "adapter",
        adapter: "telegram",
        accountId: "bot",
        actorId: "telegram:user:1",
        surface: { kind: "dm", id: "chat-1" },
      }, "", 100)).toThrow("message id is required");
    });
  });
});
