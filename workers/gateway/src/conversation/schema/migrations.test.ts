import { describe, expect, it } from "vitest";
import { runWithRealKernelSql } from "../../test-support/real-kernel-sql";
import { runSqlMigrations } from "../../schema/runner";
import { ConversationStore } from "../store";
import { CONVERSATION_MIGRATIONS, CONVERSATION_SCHEMA_COMPONENT, runConversationSqlMigrations } from "./migrations";

describe("conversation schema upgrades", () => {
  it("reads and appends ordinary text without removing an experimental local v7 column", async () => {
    await runWithRealKernelSql((sql, storage) => {
      runSqlMigrations(storage, CONVERSATION_SCHEMA_COMPONENT, [
        ...CONVERSATION_MIGRATIONS.filter((migration) => migration.id < 7),
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

  it("drops origin details from before DIDs and keeps their messages readable", async () => {
    await runWithRealKernelSql((sql, storage) => {
      runSqlMigrations(storage, CONVERSATION_SCHEMA_COMPONENT, CONVERSATION_MIGRATIONS.filter((migration) => migration.id < 8));
      sql.exec("INSERT INTO conversation_meta (conversation_id, owner_uid, kind, created_at) VALUES ('conversation', 1000, 'contact', 1)");
      const social = JSON.stringify({
        threadId: "thread:mara", reference: { actor: { shipId: "ship:mara", subjectId: "subject:mara" }, messageId: "origin:one" },
        provenance: { kind: "human" },
      });
      sql.exec("INSERT INTO messages (message_id, idempotency_key, author_json, text, social_json, origin_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        "old", "old", JSON.stringify({ kind: "contact", contactId: "contact:mara", shipId: "ship:mara", subjectId: "subject:mara", displayName: "Mara" }),
        "Before DIDs", social, JSON.stringify({ kind: "client" }), 1);
      sql.exec(`INSERT INTO message_origins (ship_id, subject_id, origin_message_id, thread_id, message_id, sequence)
        VALUES ('ship:mara', 'subject:mara', 'origin:one', 'thread:mara', 'old', 1)`);
      runConversationSqlMigrations(storage);
      runConversationSqlMigrations(storage);

      const store = new ConversationStore(sql);
      const author = { kind: "contact" as const, contactId: "contact:mara", displayName: "Mara" };
      expect(store.messageAt(1)).toEqual({
        id: "old", conversationId: "conversation", sequence: 1, author, text: "Before DIDs", origin: { kind: "client" }, createdAt: 1,
      });
      expect(sql.exec("PRAGMA table_info(messages)").toArray().map((column) => column.name)).not.toContain("legacy_social_json");
      expect(sql.exec("SELECT name FROM sqlite_master WHERE name IN ('message_origins_legacy', 'messages_awaiting_move')").toArray())
        .toEqual([]);
      expect(sql.exec("SELECT COUNT(*) AS count FROM message_origins").one().count).toBe(0);

      // Messages now name their author's Ship by DID.
      const reference = { did: "did:plc:maraaaaaaaaaaaaaaaaaaaaa", messageId: "origin:two" };
      store.append({ messageId: "new", idempotencyKey: "new", payloadHash: "fixture", text: "With DIDs", author,
        origin: { kind: "client" }, createdAt: 2, social: { threadId: "thread:mara", reference, provenance: { kind: "human" } } });
      expect(store.messageAt(2)?.social?.reference).toEqual(reference);
      expect(store.resolveOrigin(reference, "thread:mara")).toEqual({ messageId: "new", sequence: 2 });
    });
  });

  it("keeps origin details the move named by DID", async () => {
    await runWithRealKernelSql((sql, storage) => {
      runSqlMigrations(storage, CONVERSATION_SCHEMA_COMPONENT, CONVERSATION_MIGRATIONS.filter((migration) => migration.id < 9));
      sql.exec("INSERT INTO conversation_meta (conversation_id, owner_uid, kind, created_at) VALUES ('conversation', 1000, 'contact', 1)");
      const reference = { did: "did:plc:maraaaaaaaaaaaaaaaaaaaaa", messageId: "origin:one" };
      const social = { threadId: "thread:mara", reference, provenance: { kind: "human" as const } };
      const author = { kind: "contact" as const, contactId: "contact:mara", displayName: "Mara" };
      sql.exec("INSERT INTO messages (message_id, idempotency_key, author_json, text, social_json, origin_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        "moved", "moved", JSON.stringify(author), "Named by the move", JSON.stringify(social), JSON.stringify({ kind: "client" }), 1);
      sql.exec(`INSERT INTO message_origins (did, origin_message_id, thread_id, message_id, sequence)
        VALUES (?, 'origin:one', 'thread:mara', 'moved', 1)`, reference.did);
      runConversationSqlMigrations(storage);

      const store = new ConversationStore(sql);
      expect(store.messageAt(1)?.social).toEqual(social);
      expect(store.resolveOrigin(reference, "thread:mara")).toEqual({ messageId: "moved", sequence: 1 });
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
