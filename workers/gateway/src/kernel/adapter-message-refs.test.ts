import { afterEach, describe, expect, it, vi } from "vitest";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import {
  ADAPTER_MESSAGE_REF_MAX_ROWS,
  ADAPTER_MESSAGE_REF_RETENTION_MS,
  AdapterMessageRefStore,
} from "./adapter-message-refs";

const SCOPE = {
  ownerUid: 1000,
  adapter: "whatsapp",
  accountId: "managed",
  surface: { kind: "dm" as const, id: "34600000000" },
};
const TARGET = { conversationId: "conv:ship", messageId: "msg:1", sequence: 7 };

function rowCount(sql: SqlStorage): number {
  return sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM adapter_message_refs").one().count;
}

describe("AdapterMessageRefStore", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps every provider message of a split delivery to one canonical reference and its part", async () => {
    await runWithRealKernelSql((sql) => {
      const store = new AdapterMessageRefStore(sql);
      store.record(SCOPE, TARGET, ["wamid.a", "wamid.b", "wamid.c"]);
      expect(store.lookup(SCOPE, "wamid.a")).toEqual({ ...TARGET, part: { index: 0, count: 3 } });
      expect(store.lookup(SCOPE, "wamid.c")).toEqual({ ...TARGET, part: { index: 2, count: 3 } });
      expect(store.lookup(SCOPE, "wamid.unknown")).toBeNull();
    });
  });

  it("stores references, never message text", async () => {
    await runWithRealKernelSql((sql) => {
      new AdapterMessageRefStore(sql).record(SCOPE, TARGET, ["wamid.a"]);
      const columns = sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('adapter_message_refs')").toArray().map(({ name }) => name);
      expect(columns).not.toContain("text");
      expect(columns).toEqual(expect.arrayContaining(["conversation_id", "message_id", "sequence"]));
    });
  });

  it("resolves only within the same owner, adapter, account and surface", async () => {
    await runWithRealKernelSql((sql) => {
      const store = new AdapterMessageRefStore(sql);
      store.record(SCOPE, TARGET, ["shared-id"]);
      expect(store.lookup(SCOPE, "shared-id")).not.toBeNull();
      expect(store.lookup({ ...SCOPE, ownerUid: 1001 }, "shared-id")).toBeNull();
      expect(store.lookup({ ...SCOPE, adapter: "telegram" }, "shared-id")).toBeNull();
      expect(store.lookup({ ...SCOPE, accountId: "other" }, "shared-id")).toBeNull();
      expect(store.lookup({ ...SCOPE, surface: { kind: "dm", id: "34611111111" } }, "shared-id")).toBeNull();
      expect(store.lookup({ ...SCOPE, surface: { kind: "group", id: "34600000000" } }, "shared-id")).toBeNull();
      expect(store.lookup({ ...SCOPE, surface: { ...SCOPE.surface, threadId: "thread" } }, "shared-id")).toBeNull();
    });
  });

  it("lets the same provider id exist independently on two surfaces", async () => {
    await runWithRealKernelSql((sql) => {
      const store = new AdapterMessageRefStore(sql);
      const elsewhere = { ...SCOPE, surface: { kind: "dm" as const, id: "elsewhere" } };
      store.record(SCOPE, TARGET, ["5"]);
      store.record(elsewhere, { ...TARGET, messageId: "msg:other", sequence: 1 }, ["5"]);
      expect(store.lookup(SCOPE, "5")?.messageId).toBe("msg:1");
      expect(store.lookup(elsewhere, "5")?.messageId).toBe("msg:other");
    });
  });

  it("keeps the first reference when a retried delivery records the same ids", async () => {
    await runWithRealKernelSql((sql) => {
      const store = new AdapterMessageRefStore(sql);
      store.record(SCOPE, TARGET, ["wamid.a"]);
      store.record(SCOPE, { ...TARGET, messageId: "msg:replay" }, ["wamid.a"]);
      expect(store.lookup(SCOPE, "wamid.a")?.messageId).toBe("msg:1");
      expect(rowCount(sql)).toBe(1);
    });
  });

  it("ignores empty ids and records nothing for a delivery without any", async () => {
    await runWithRealKernelSql((sql) => {
      const store = new AdapterMessageRefStore(sql);
      store.record(SCOPE, TARGET, []);
      store.record(SCOPE, TARGET, ["  "]);
      expect(rowCount(sql)).toBe(0);
    });
  });

  it("prunes references past the retention window at most hourly on write", async () => {
    await runWithRealKernelSql((sql) => {
      const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
      const store = new AdapterMessageRefStore(sql);
      store.record(SCOPE, TARGET, ["old"]);

      now.mockReturnValue(1_000 + ADAPTER_MESSAGE_REF_RETENTION_MS + 1);
      store.record(SCOPE, { ...TARGET, messageId: "msg:2" }, ["fresh"]);
      expect(store.lookup(SCOPE, "old")).toBeNull();
      expect(store.lookup(SCOPE, "fresh")).not.toBeNull();
    });
  });

  it("never returns an expired reference even before the next prune", async () => {
    await runWithRealKernelSql((sql) => {
      const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
      const store = new AdapterMessageRefStore(sql);
      store.record(SCOPE, TARGET, ["old"]);
      now.mockReturnValue(1_000 + ADAPTER_MESSAGE_REF_RETENTION_MS + 1);
      expect(store.lookup(SCOPE, "old")).toBeNull();
    });
  });

  it("bounds the table by dropping the oldest references past the row cap", async () => {
    await runWithRealKernelSql((sql) => {
      const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
      const store = new AdapterMessageRefStore(sql);
      store.record(SCOPE, TARGET, ["oldest"]);
      sql.exec("UPDATE adapter_message_refs SET id = 1");
      sql.exec(
        `INSERT INTO adapter_message_refs (
           id, owner_uid, adapter, account_id, surface_kind, surface_id, thread_id,
           provider_message_id, conversation_id, message_id, sequence, part_index, part_count, created_at
         ) VALUES (?, 1000, 'whatsapp', 'managed', 'dm', '34600000000', '', 'newest', 'conv:ship', 'msg:n', 2, 0, 1, 1000)`,
        ADAPTER_MESSAGE_REF_MAX_ROWS + 5,
      );
      now.mockReturnValue(1_000 + 2 * 60 * 60 * 1000);
      store.record(SCOPE, { ...TARGET, messageId: "msg:3" }, ["trigger"]);
      expect(store.lookup(SCOPE, "oldest")).toBeNull();
      expect(store.lookup(SCOPE, "newest")).not.toBeNull();
    });
  });

  it("writes one small row and reads nothing for an ordinary delivery", async () => {
    await runWithRealKernelSql((sql) => {
      const store = new AdapterMessageRefStore(sql);
      store.record(SCOPE, TARGET, ["first"]);
      const exec = vi.spyOn(sql, "exec");
      store.record(SCOPE, { ...TARGET, messageId: "msg:2" }, ["second"]);
      expect(exec).toHaveBeenCalledTimes(1);
      expect(String(exec.mock.calls[0]![0])).toMatch(/^\s*INSERT OR IGNORE/);
    });
  });
});
