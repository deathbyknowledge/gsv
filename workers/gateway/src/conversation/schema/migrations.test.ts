import { describe, expect, it } from "vitest";
import { runWithRealKernelSql } from "../../test-support/real-kernel-sql";
import { runSqlMigrations } from "../../schema/runner";
import { ConversationStore } from "../store";
import { CONVERSATION_MIGRATIONS, CONVERSATION_SCHEMA_COMPONENT, runConversationSqlMigrations } from "./migrations";

describe("conversation schema upgrades", () => {
  it("reads and appends ordinary text without removing an experimental local v7 column", async () => {
    await runWithRealKernelSql((sql, storage) => {
      runSqlMigrations(storage, CONVERSATION_SCHEMA_COMPONENT, [
        ...CONVERSATION_MIGRATIONS,
        { id: 7, name: "message_action", statements: ["ALTER TABLE messages ADD COLUMN action_json TEXT"] },
      ]);
      sql.exec("INSERT INTO conversation_meta (conversation_id, owner_uid, kind, created_at) VALUES ('conversation', 1000, 'ship', 1)");
      const text = "Help me create a routine.\n\nCheck my calendar.";
      const metadata = JSON.stringify({ kind: "routine.create", note: "Check my calendar." });
      sql.exec("INSERT INTO messages (message_id, idempotency_key, author_json, text, origin_json, created_at, action_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
        "old", "old", JSON.stringify({ kind: "user", uid: 1000 }), text, JSON.stringify({ kind: "client" }), 1, metadata);
      runConversationSqlMigrations(storage);
      const store = new ConversationStore(sql);
      expect(store.messageAt(1)).toMatchObject({ id: "old", text });
      expect(store.messageAt(1)).not.toHaveProperty("action");
      expect(sql.exec("SELECT action_json FROM messages WHERE message_id = 'old'").one().action_json).toBe(metadata);
      expect(sql.exec("SELECT id FROM _gsv_schema_migrations WHERE component = 'conversation' AND id = 7").toArray()).toHaveLength(1);
      store.append({ messageId: "new", idempotencyKey: "new", payloadHash: "fixture", text: "Just explain the options.",
        author: { kind: "user", uid: 1000 }, origin: { kind: "client" }, createdAt: 2 });
      runConversationSqlMigrations(storage);
      expect(new ConversationStore(sql).messageAt(2)?.text).toBe("Just explain the options.");
      expect(sql.exec("SELECT action_json FROM messages WHERE message_id = 'new'").one().action_json).toBeNull();
    });
  });

  it("does not add request-specific storage to a fresh conversation", async () => {
    await runWithRealKernelSql((sql, storage) => {
      runConversationSqlMigrations(storage);
      expect(sql.exec("PRAGMA table_info(messages)").toArray().some((column) => column.name === "action_json")).toBe(false);
    });
  });

  it("preserves old messages without inventing a selected target", async () => {
    await runWithRealKernelSql((sql, storage) => {
      runSqlMigrations(storage, CONVERSATION_SCHEMA_COMPONENT, CONVERSATION_MIGRATIONS.slice(0, 3));
      sql.exec("INSERT INTO conversation_meta (conversation_id, owner_uid, kind, created_at) VALUES ('conversation', 1000, 'ship', 1)");
      sql.exec("INSERT INTO messages (message_id, idempotency_key, author_json, text, origin_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        "message", "receipt", JSON.stringify({ kind: "user", uid: 1000 }), "Original text", JSON.stringify({ kind: "client" }), 1);
      runConversationSqlMigrations(storage);
      const store = new ConversationStore(sql);
      expect(store.messageAt(1)).toMatchObject({ id: "message", text: "Original text" });
      expect(store.messageAt(1)?.selectedTarget).toBeUndefined();
      expect(store.search('"Original"*', 2, 10)).toEqual([]);
      const appended = store.append({ messageId: "selected", idempotencyKey: "selected", payloadHash: "fixture", text: "New text", selectedTarget: "macbook",
        author: { kind: "user", uid: 1000 }, origin: { kind: "client" }, createdAt: 2 });
      expect(appended?.message.selectedTarget).toBe("macbook");
      runConversationSqlMigrations(storage);
      expect(store.messageAt(2)?.selectedTarget).toBe("macbook");
      expect(store.search('"text"*', 3, 10)).toEqual([2]);
      expect(sql.exec("SELECT name FROM sqlite_master WHERE name = 'message_search_content'").toArray()).toEqual([]);
      expect(sql.exec("SELECT text FROM message_search WHERE message_search MATCH 'New'").toArray()).toEqual([{ text: null }]);
    });
  });
});
