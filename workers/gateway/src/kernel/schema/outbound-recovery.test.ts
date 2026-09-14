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
      const store = new MailboxStore(sql);
      const fingerprint = `sha256:${"a".repeat(64)}`;
      for (const outboundId of ["pending", "accepted"]) {
        store.ensureOutbound({ version: 1, outboundId, fingerprint, ownerUid: 1000, deliveryId: outboundId,
          from: "fixture@example.invalid", to: "recipient@example.invalid", subject: "Preserved draft", bodyDigest: fingerprint,
          bodyPath: `/home/fixture/.gsv/mail/outbox/${outboundId}.txt`, textSize: 10, createdAt: 1 });
        store.markOutboundQueued(outboundId, fingerprint);
        store.markOutboundEnqueued(outboundId, fingerprint);
      }
      store.completeOutbound({ version: 1, outboundId: "accepted", fingerprint, state: "accepted", providerMessageId: "existing-provider" });
      const rows = sql.exec("SELECT * FROM mail_outbound ORDER BY outbound_id").toArray();
      runKernelSqlMigrations(storage);
      runKernelSqlMigrations(storage);
      expect(listAppliedSqlMigrations(storage, KERNEL_SCHEMA_COMPONENT).filter((migration) => migration.id < 51)).toEqual(migrations);
      expect(sql.exec("SELECT * FROM mail_outbound ORDER BY outbound_id").toArray()).toEqual(rows);
      expect(store.pendingOutboundEnqueues()).toEqual([{ outboundId: "pending", nextAt: null }]);
      expect(sql.exec<{ outbound_id: string }>("SELECT outbound_id FROM mail_outbound INDEXED BY idx_mail_outbound_enqueue WHERE state = 'queued'").toArray())
        .toEqual([{ outbound_id: "pending" }]);
    });
  });
});
