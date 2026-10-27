import { describe, expect, it } from "vitest";
import { runSqlMigrations } from "../../schema/runner";
import { runWithRealKernelSql } from "../../test-support/real-kernel-sql";
import { MailboxStore } from "../mailbox-store";
import { KERNEL_MIGRATIONS, KERNEL_SCHEMA_COMPONENT, runKernelSqlMigrations } from "./migrations";

describe("mail search upgrade", () => {
  it("makes mail received before the index searchable by its headers and summary", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      await storage.deleteAll();
      runSqlMigrations(storage, KERNEL_SCHEMA_COMPONENT, KERNEL_MIGRATIONS.filter((migration) => migration.id < 83));
      sql.exec("INSERT INTO mailboxes (mailbox_id, owner_uid, address, created_at, updated_at) VALUES ('mailbox:1000:primary', 1000, 'hank@gsv.space', 1, 1)");
      sql.exec(`INSERT INTO mail_messages (
        message_id, mailbox_id, digest, envelope_from, envelope_to, display_from, to_json, cc_json, reply_to_json,
        subject, received_at, raw_path, text_path, size_bytes, attachments_json, summary, summarized_at, created_at
      ) VALUES ('mail_old', 'mailbox:1000:primary', 'sha256:old', 'billing@example.net', 'hank@gsv.space', 'Example Billing',
        '["hank@gsv.space"]', '[]', '[]', 'Your receipt', 1000, '/raw', '/text', 1, '[]', 'Invoice for hosting.', 2, 2)`);

      runKernelSqlMigrations(storage);
      runKernelSqlMigrations(storage);

      const store = new MailboxStore(sql);
      const ids = (query: string) => store.search(1000, query).messages.map((message) => message.messageId);
      expect(ids("receipt")).toEqual(["mail_old"]);
      expect(ids("billing")).toEqual(["mail_old"]);
      expect(ids("hosting")).toEqual(["mail_old"]);

      store.recordMessage({
        messageId: "mail_new", mailboxId: "mailbox:1000:primary", intakeId: "intake-new", digest: "sha256:new",
        envelopeFrom: "friend@example.com", envelopeTo: "hank@gsv.space", headerMessageId: null, displayFrom: null,
        to: ["hank@gsv.space"], cc: [], replyTo: [], subject: "Dinner", sentAt: null, receivedAt: 3000,
        rawPath: "/raw-new", textPath: "/text-new", sizeBytes: 1, attachments: [], bodyText: "Tapas on Friday?",
      });
      expect(ids("tapas")).toEqual(["mail_new"]);
      expect(ids("receipt")).toEqual(["mail_old"]);
    });
  });
});
