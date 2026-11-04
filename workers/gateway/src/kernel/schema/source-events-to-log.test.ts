import { describe, expect, it } from "vitest";
import { runSqlMigrations } from "../../schema/runner";
import { runWithRealKernelSql } from "../../test-support/real-kernel-sql";
import { KERNEL_MIGRATIONS, KERNEL_SCHEMA_COMPONENT, runKernelSqlMigrations } from "./migrations";

describe("source events to log migration", () => {
  it("moves what arrived from each source into the Kernel log, in arrival order, and drops event_log", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      await storage.deleteAll();
      runSqlMigrations(storage, KERNEL_SCHEMA_COMPONENT, KERNEL_MIGRATIONS.filter((migration) => migration.id < 97));
      sql.exec(
        `INSERT INTO event_sources (source_id, owner_uid, name, label, notify, ship, webhook, bucket_tokens, bucket_at, created_by, created_at, updated_at)
         VALUES ('src_a', 1000, 'feed', 'Feed', 'messenger', 'none', 'none', 120, 1, 'person', 1, 1)`,
      );
      const arrived = `INSERT INTO event_log (source_id, event_id, owner_uid, title, preview, body, emitted_by, received_at)
        VALUES ('src_a', ?, 1000, ?, ?, ?, ?, ?)`;
      sql.exec(arrived, "full", "Full", "seen", "private", "webhook", 30);
      sql.exec(arrived, "bare", "Bare", null, null, "process", 10);
      // The old limit counted characters, so a stored body can be past 64 KiB.
      sql.exec(arrived, "huge", "Huge", null, "x".repeat(65_536), "client", 20);

      runKernelSqlMigrations(storage);
      runKernelSqlMigrations(storage);

      const rows = sql.exec<{
        type: string; owner_uid: number; subject: string; actor_json: string; idempotency_key: string; body_json: string; created_at: number;
      }>("SELECT type, owner_uid, subject, actor_json, idempotency_key, body_json, created_at FROM events ORDER BY seq")
        .toArray().map(({ actor_json, body_json, ...row }) => ({ ...row, actor: JSON.parse(actor_json), body: JSON.parse(body_json) }));
      const moved = { type: "source.event", owner_uid: 1000, subject: "source:src_a", actor: { kind: "source", sourceId: "src_a" } };
      expect(rows).toEqual([
        { ...moved, idempotency_key: "src_a:bare", body: { eventId: "bare", title: "Bare", emittedBy: "process" }, created_at: 10 },
        { ...moved, idempotency_key: "src_a:huge", body: { eventId: "huge", title: "Huge", emittedBy: "client" }, created_at: 20 },
        {
          ...moved, idempotency_key: "src_a:full",
          body: { eventId: "full", title: "Full", preview: "seen", body: "private", emittedBy: "webhook" }, created_at: 30,
        },
      ]);
      expect(sql.exec("SELECT count(*) AS count FROM deliveries").one().count).toBe(0);
      expect(sql.exec("SELECT name FROM sqlite_master WHERE name = 'event_log'").toArray()).toEqual([]);
    });
  });
});
