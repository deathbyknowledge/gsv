import { describe, expect, it } from "vitest";
import { runSqlMigrations } from "../../schema/runner";
import { runWithRealKernelSql } from "../../test-support/real-kernel-sql";
import { ConversationRegistry } from "../conversations";
import { KERNEL_MIGRATIONS, KERNEL_SCHEMA_COMPONENT, runKernelSqlMigrations } from "./migrations";

describe("contact conversation upgrade", () => {
  it("detaches contact handlers while preserving Ship, history addresses and membership", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      await storage.deleteAll();
      runSqlMigrations(storage, KERNEL_SCHEMA_COMPONENT, KERNEL_MIGRATIONS.filter((migration) => migration.id < 54));
      for (const kind of ["ship", "contact"]) {
        sql.exec(`INSERT INTO conversations
          (conversation_id, owner_uid, kind, handler_pid, latest_sequence, created_at, updated_at)
          VALUES (?, 1000, ?, 'proc:ship', 42, 1, 2)`, `conv:${kind}`, kind);
        sql.exec(`INSERT INTO conversation_members
          (conversation_id, member_kind, member_id, role, created_at)
          VALUES (?, 'process', 'proc:ship', 'handler', 1)`, `conv:${kind}`);
      }
      runKernelSqlMigrations(storage);
      runKernelSqlMigrations(storage);
      const registry = new ConversationRegistry(sql);
      expect(registry.get("conv:ship")).toMatchObject({ handlerPid: "proc:ship", latestSequence: 42 });
      expect(registry.get("conv:contact")).toEqual({
        id: "conv:contact", kind: "contact", ownerUid: 1000, title: null,
        latestSequence: 42, createdAt: 1, updatedAt: 2,
      });
      expect(registry.members("conv:contact")).toEqual([{ kind: "process", id: "proc:ship", role: "observer" }]);
    });
  });
});
