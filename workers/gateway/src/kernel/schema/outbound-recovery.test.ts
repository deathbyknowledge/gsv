import { describe, expect, it } from "vitest";
import { listAppliedSqlMigrations, runSqlMigrations } from "../../schema/runner";
import { runWithRealKernelSql } from "../../test-support/real-kernel-sql";
import { MailboxStore } from "../mailbox-store";
import { KERNEL_MIGRATIONS, KERNEL_SCHEMA_COMPONENT, runKernelSqlMigrations } from "./migrations";

describe("outbound recovery migration", () => {
  it("preserves published pending drafts and terminal receipts while indexing every queued intent", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      await storage.deleteAll();
      runSqlMigrations(storage, KERNEL_SCHEMA_COMPONENT, KERNEL_MIGRATIONS.filter((migration) => migration.id < 51));
      const migrations = listAppliedSqlMigrations(storage, KERNEL_SCHEMA_COMPONENT);
      const fingerprint = `sha256:${"a".repeat(64)}`;
      // Rows as that release wrote them; the store writes columns later migrations add.
      for (const [outboundId, state, providerMessageId, completedAt] of [
        ["pending", "queued", null, null],
        ["accepted", "accepted", "existing-provider", 4],
      ] as const) {
        sql.exec(
          `INSERT INTO mail_outbound (outbound_id, owner_uid, delivery_id, fingerprint, from_address, to_address, subject,
             body_digest, body_path, text_size, state, provider_message_id, created_at, queued_at, enqueued_at, completed_at)
           VALUES (?, 1000, ?, ?, 'fixture@example.invalid', 'recipient@example.invalid', 'Preserved draft', ?, ?, 10, ?, ?, 1, 2, 3, ?)`,
          outboundId, outboundId, fingerprint, fingerprint, `/home/fixture/.gsv/mail/outbox/${outboundId}.txt`,
          state, providerMessageId, completedAt,
        );
      }
      const rows = sql.exec("SELECT * FROM mail_outbound ORDER BY outbound_id").toArray();
      runKernelSqlMigrations(storage);
      runKernelSqlMigrations(storage);
      expect(listAppliedSqlMigrations(storage, KERNEL_SCHEMA_COMPONENT).filter((migration) => migration.id < 51)).toEqual(migrations);
      expect(sql.exec("SELECT * FROM mail_outbound ORDER BY outbound_id").toArray())
        .toEqual(rows.map((row) => ({ ...row, cc_addresses: null, invite_method: null, invite_text: null })));
      const store = new MailboxStore(sql);
      expect(store.getOutbound("accepted")).toMatchObject({ to: ["recipient@example.invalid"], cc: [], state: "accepted" });
      expect(store.getOutbound("accepted")).not.toHaveProperty("invite");
      expect(store.pendingOutboundEnqueues()).toEqual([{ outboundId: "pending", nextAt: null }]);
      expect(sql.exec<{ outbound_id: string }>("SELECT outbound_id FROM mail_outbound INDEXED BY idx_mail_outbound_enqueue WHERE state = 'queued'").toArray())
        .toEqual([{ outbound_id: "pending" }]);
    });
  });
});
