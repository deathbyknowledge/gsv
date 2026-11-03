import { describe, expect, it } from "vitest";
import { runSqlMigrations } from "../../schema/runner";
import { runWithRealKernelSql } from "../../test-support/real-kernel-sql";
import { KERNEL_MIGRATIONS, KERNEL_SCHEMA_COMPONENT, runKernelSqlMigrations } from "./migrations";

const FIRST = "r12y:00000000-0000-4000-8000-000000000001";
const SECOND = "r12y:00000000-0000-4000-8000-000000000002";

describe("responsibility wakes migration", () => {
  it("moves wake batches still on their way into the log, with their retry state", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      await storage.deleteAll();
      runSqlMigrations(storage, KERNEL_SCHEMA_COMPONENT, KERNEL_MIGRATIONS.filter((migration) => migration.id < 94));
      const insert = `INSERT INTO responsibility_wake_batches (
          batch_id, owner_uid, through_revision, responsibility_ids_json, event_id, attempt_count, last_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
      sql.exec(insert, "batch:one", 1000, 7, JSON.stringify([FIRST, SECOND]), "r12y.ready:batch:one", 0, null, 5, 5);
      sql.exec(insert, "batch:two", 1001, 3, JSON.stringify([FIRST]), "r12y.ready:batch:two", 2, "Process is restarting", 10, 40);

      runKernelSqlMigrations(storage);
      runKernelSqlMigrations(storage);

      expect(sql.exec("SELECT name FROM sqlite_master WHERE name = 'responsibility_wake_batches'").toArray()).toEqual([]);
      const events = sql.exec<{ seq: number; actor_json: string; body_json: string }>("SELECT * FROM events ORDER BY seq").toArray();
      expect(events.map(({ seq: _seq, actor_json, body_json, ...row }) => ({ ...row, actor: JSON.parse(actor_json), body: JSON.parse(body_json) }))).toEqual([
        {
          type: "responsibility.ready", owner_uid: 1000, subject: "owner:1000", idempotency_key: "batch:one", created_at: 5,
          actor: { kind: "kernel" }, body: { responsibilityIds: [FIRST, SECOND], ledgerRevision: 7 },
        },
        {
          type: "responsibility.ready", owner_uid: 1001, subject: "owner:1001", idempotency_key: "batch:two", created_at: 10,
          actor: { kind: "kernel" }, body: { responsibilityIds: [FIRST], ledgerRevision: 3 },
        },
      ]);
      // A batch that already failed retries at once, as the wake timer would have.
      expect(sql.exec("SELECT seq, consumer, lane, state, attempt_count, next_attempt_at, last_error, updated_at FROM deliveries ORDER BY seq").toArray()).toEqual([
        { seq: events[0]!.seq, consumer: "personal:1000", lane: "background", state: "pending", attempt_count: 0, next_attempt_at: 5, last_error: null, updated_at: 5 },
        { seq: events[1]!.seq, consumer: "personal:1001", lane: "background", state: "pending", attempt_count: 2, next_attempt_at: 40, last_error: "Process is restarting", updated_at: 40 },
      ]);
    });
  });
});
