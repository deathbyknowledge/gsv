import { describe, expect, it } from "vitest";
import { runSqlMigrations } from "../../schema/runner";
import { runWithRealKernelSql } from "../../test-support/real-kernel-sql";
import { EventSourceStore } from "../event-sources";
import { KERNEL_MIGRATIONS, KERNEL_SCHEMA_COMPONENT, runKernelSqlMigrations } from "./migrations";

describe("webhook signature schemes migration", () => {
  it("turns sender-named webhooks into the schemes that sign them and keeps every event", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      await storage.deleteAll();
      runSqlMigrations(storage, KERNEL_SCHEMA_COMPONENT, KERNEL_MIGRATIONS.filter((migration) => migration.id < 91));
      for (const [id, name, webhook] of [["src_gh", "gh", "github"], ["src_pay", "pay", "stripe"], ["src_open", "open", "url"], ["src_cli", "cli", "none"]]) {
        sql.exec(
          `INSERT INTO event_sources (source_id, owner_uid, name, label, notify, ship, webhook, secret, bucket_tokens, bucket_at,
            created_by, created_at, updated_at) VALUES (?, 1000, ?, ?, 'messenger', 'none', ?, ?, 120, 1, 'person', 1, 1)`,
          id, name, name, webhook, webhook === "none" ? null : `secret-${name}`,
        );
        sql.exec(
          `INSERT INTO event_log (source_id, event_id, owner_uid, title, emitted_by, received_at)
           VALUES (?, 'e1', 1000, 'kept', 'webhook', 5)`,
          id,
        );
      }

      runKernelSqlMigrations(storage);
      runKernelSqlMigrations(storage);

      const sources = new EventSourceStore(storage).list(1000);
      expect(sources.map(({ name, webhook, hmac, senderSecret }) => ({ name, webhook, hmac, senderSecret }))).toEqual([
        { name: "cli", webhook: "none", hmac: undefined, senderSecret: undefined },
        {
          name: "gh",
          webhook: "hmac",
          hmac: { header: "x-hub-signature-256", encoding: "hex", prefix: "sha256=", idHeader: "x-github-delivery", typeHeader: "x-github-event" },
          senderSecret: undefined,
        },
        { name: "open", webhook: "url", hmac: undefined, senderSecret: undefined },
        { name: "pay", webhook: "hmac", hmac: { header: "stripe-signature", encoding: "hex", pairs: { timestamp: "t", signature: "v1" } }, senderSecret: true },
      ]);
      expect(sql.exec("SELECT source_id, secret FROM event_sources ORDER BY source_id").toArray()).toEqual([
        { source_id: "src_cli", secret: null },
        { source_id: "src_gh", secret: "secret-gh" },
        { source_id: "src_open", secret: "secret-open" },
        { source_id: "src_pay", secret: "secret-pay" },
      ]);
      expect(sql.exec("SELECT source_id, title FROM event_log ORDER BY source_id").toArray()).toEqual([
        { source_id: "src_cli", title: "kept" },
        { source_id: "src_gh", title: "kept" },
        { source_id: "src_open", title: "kept" },
        { source_id: "src_pay", title: "kept" },
      ]);
      // Removing a source still takes its events with it.
      sql.exec("DELETE FROM event_sources WHERE source_id = 'src_gh'");
      expect(sql.exec("SELECT count(*) AS count FROM event_log").one().count).toBe(3);
      expect(() => sql.exec(
        `INSERT INTO event_sources (source_id, owner_uid, name, label, notify, ship, webhook, bucket_tokens, bucket_at,
          created_by, created_at, updated_at) VALUES ('src_bad', 1000, 'bad', 'bad', 'none', 'none', 'hmac', 1, 1, 'person', 1, 1)`,
      )).toThrow();
    });
  });
});
