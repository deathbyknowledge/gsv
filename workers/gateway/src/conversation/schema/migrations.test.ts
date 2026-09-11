import { describe, expect, it } from "vitest";
import { runWithRealKernelSql } from "../../test-support/real-kernel-sql";
import { runSqlMigrations } from "../../schema/runner";
import { ConversationStore } from "../store";
import { CONVERSATION_MIGRATIONS, CONVERSATION_SCHEMA_COMPONENT, runConversationSqlMigrations } from "./migrations";

describe("conversation schema upgrades", () => {
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
      const appended = store.append({ messageId: "selected", idempotencyKey: "selected", payloadHash: "fixture", text: "New text", selectedTarget: "macbook",
        author: { kind: "user", uid: 1000 }, origin: { kind: "client" }, createdAt: 2 });
      expect(appended?.message.selectedTarget).toBe("macbook");
      runConversationSqlMigrations(storage);
      expect(store.messageAt(2)?.selectedTarget).toBe("macbook");
    });
  });
});
