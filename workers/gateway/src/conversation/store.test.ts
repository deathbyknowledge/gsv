import { describe, expect, it } from "vitest";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { runConversationSqlMigrations } from "./schema/migrations";
import { ConversationStore } from "./store";

function message(sequence: number, text = `message ${sequence}`) {
  return { messageId: `message:${sequence}`, idempotencyKey: `input:${sequence}`, payloadHash: `hash:${sequence}`,
    text, author: { kind: "user" as const, uid: 1000 }, origin: { kind: "client" as const }, createdAt: sequence };
}

describe("conversation search retention", () => {
  it("reclaims index space incrementally while retaining messages, receipts and newest search results", async () => {
    await runWithRealKernelSql((sql, storage) => {
      runConversationSqlMigrations(storage);
      const store = new ConversationStore(sql);
      store.initialize("conversation", 1000, "ship");
      for (let sequence = 1; sequence <= 1_000; sequence++) {
        const text = `message ${sequence} ` + Array.from({ length: 100 }, (_, word) => `token${sequence * 100 + word}`).join(" ");
        storage.transactionSync(() => store.append(message(sequence, text)));
      }
      // Exercise a large merged segment, where DELETE initially leaves tombstones instead of freeing pages.
      sql.exec("INSERT INTO message_search(message_search) VALUES ('optimize')");
      const original = store.messageAt(1);
      const budget = sql.databaseSize - 128 * 1024;
      const constrained = new ConversationStore(sql, budget);
      let newest = 1_000;
      while (sql.databaseSize > budget && newest < 1_200) {
        storage.transactionSync(() => constrained.append(message(++newest)));
      }
      expect(sql.databaseSize).toBeLessThanOrEqual(budget);
      expect(newest).toBeLessThan(1_200);
      expect(constrained.search('"token100"', newest + 1, 10)).toEqual([]);
      expect(constrained.search(`"message" AND "${newest}"`, newest + 1, 10)).toEqual([newest]);
      expect(constrained.messageAt(1)).toEqual(original);
      expect(constrained.receipt("input:1")).toMatchObject({ messageId: "message:1", sequence: 1, payloadHash: "hash:1" });
      expect(storage.transactionSync(() => constrained.append(message(1, original!.text))))
        .toEqual({ message: original, created: false });
      expect(constrained.search('"token100"', newest + 1, 10)).toEqual([]);
      expect(sql.exec("SELECT COUNT(*) AS count FROM message_receipts").one().count).toBe(newest);
    });
  });

  it("preserves the newest result when non-search data alone exceeds the budget", async () => {
    await runWithRealKernelSql((sql, storage) => {
      runConversationSqlMigrations(storage);
      const store = new ConversationStore(sql, 0);
      store.initialize("conversation", 1000, "ship");
      for (let sequence = 1; sequence <= 10; sequence++) {
        storage.transactionSync(() => store.append(message(sequence)));
        expect(store.search(`"message" AND "${sequence}"`, sequence + 1, 10)).toEqual([sequence]);
      }
      expect(store.listHot(11, 10)).toHaveLength(10);
      const before = store.search('"message"', 11, 20);
      expect(() => storage.transactionSync(() => {
        store.append(message(11));
        throw new Error("rollback");
      })).toThrow("rollback");
      expect(store.search('"message"', 12, 20)).toEqual(before);
      expect(store.messageAt(11)).toBeNull();
      expect(store.receipt("input:11")).toBeNull();
    });
  });
});
