import { describe, expect, it } from "vitest";
import { runSqlMigrations } from "../../schema/runner";
import { runWithRealKernelSql } from "../../test-support/real-kernel-sql";
import { KERNEL_MIGRATIONS, KERNEL_SCHEMA_COMPONENT, runKernelSqlMigrations } from "./migrations";

describe("work return checkpoint migration", () => {
  it("lets a /ship an older Kernel checkpointed start afresh, leaving every other receipt", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      await storage.deleteAll();
      runSqlMigrations(storage, KERNEL_SCHEMA_COMPONENT, KERNEL_MIGRATIONS.filter((migration) => migration.id < 100));
      const insert = `INSERT INTO adapter_ingress_receipts
        (receipt_id, adapter, account_id, actor_id, surface_kind, surface_id, provider_message_id, state, progress_json, claim_token, claimed_at, created_at)
        VALUES (?, 'whatsapp', 'primary', 'wa:+123', 'dm', 'dm-1', ?, ?, ?, 'claim', 1, 1)`;
      const workReturn = JSON.stringify({
        kind: "work_return", uid: 1000, workPid: "proc:work",
        route: { adapter: "whatsapp", accountId: "primary", actorId: "wa:+123", surfaceKind: "dm", surfaceId: "dm-1", mode: "work" },
      });
      const replyPreference = JSON.stringify({ kind: "reply_preference", uid: 1000, order: 1 });
      sql.exec(insert, "receipt:ship", "wamid-ship", "in_progress", workReturn);
      sql.exec(insert, "receipt:message", "wamid-message", "in_progress", replyPreference);
      sql.exec(insert, "receipt:fresh", "wamid-fresh", "in_progress", null);
      sql.exec(insert, "receipt:done", "wamid-done", "completed", workReturn);

      runKernelSqlMigrations(storage);
      runKernelSqlMigrations(storage);

      expect(sql.exec("SELECT receipt_id, progress_json FROM adapter_ingress_receipts ORDER BY receipt_id").toArray()).toEqual([
        { receipt_id: "receipt:done", progress_json: workReturn },
        { receipt_id: "receipt:fresh", progress_json: null },
        { receipt_id: "receipt:message", progress_json: replyPreference },
        { receipt_id: "receipt:ship", progress_json: null },
      ]);
    });
  });
});
