import { describe, expect, it } from "vitest";
import { runSqlMigrations } from "../../schema/runner";
import { runWithRealKernelSql } from "../../test-support/real-kernel-sql";
import { KERNEL_MIGRATIONS, KERNEL_SCHEMA_COMPONENT, runKernelSqlMigrations } from "./migrations";

const ROUTE = {
  kind: "adapter", runId: "run-1", processId: "worker", uid: 1000,
  destination: { kind: "adapter", adapter: "whatsapp", accountId: "primary", actorId: "wa:+123", surface: { kind: "dm", id: "dm-1" } },
};

describe("delivery notices migration", () => {
  it("moves failed-delivery notices still on their way to their processes into the log", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      await storage.deleteAll();
      runSqlMigrations(storage, KERNEL_SCHEMA_COMPONENT, KERNEL_MIGRATIONS.filter((migration) => migration.id < 101));
      sql.exec(
        `INSERT INTO processes (process_id, uid, owner_uid, gid, gids, username, home, cwd, created_at)
         VALUES ('worker', 1001, 1000, 1001, '[1001]', 'crew', '/home/crew', '/home/crew', 1)`,
      );
      const insertTask = "INSERT INTO cf_agents_schedules (id, callback, payload, type, time, created_at) VALUES (?, ?, ?, 'scheduled', ?, ?)";
      const notice = { runId: "run-1", processId: "worker", route: ROUTE };
      sql.exec(insertTask, "task:reply", "onProcessDeliveryNotice", JSON.stringify({
        ...notice, noticeId: "notice-reply", deliveryKind: "message", deliveryId: "message-1", state: "permanent",
        message: "The message could not be delivered: chat closed",
      }), 2, 20);
      sql.exec(insertTask, "task:approval", "onProcessDeliveryNotice", JSON.stringify({
        ...notice, noticeId: "notice-approval", deliveryKind: "hil", requestId: "approval-1", state: "exhausted",
        message: "The approval notification stopped after 10 retry-safe delivery attempts: timeout",
      }), 1, 10);
      // Its process was killed, so there is no one left to tell.
      sql.exec(insertTask, "task:killed", "onProcessDeliveryNotice", JSON.stringify({
        ...notice, processId: "killed", noticeId: "notice-killed", deliveryKind: "message", state: "ambiguous", message: "ambiguous",
      }), 3, 30);
      sql.exec(insertTask, "task:route", "onAdapterRouteDelivery", JSON.stringify({ runId: "run-1", processId: "worker", event: "message.committed", attempt: 2 }), 4, 40);

      runKernelSqlMigrations(storage);
      runKernelSqlMigrations(storage);

      const events = sql.exec<{ seq: number; type: string; owner_uid: number; subject: string; actor_json: string; idempotency_key: string; body_json: string; created_at: number }>(
        "SELECT * FROM events ORDER BY seq",
      ).toArray();
      expect(events.map(({ seq: _seq, actor_json, body_json, ...row }) => ({ ...row, actor: JSON.parse(actor_json), body: JSON.parse(body_json) }))).toEqual([
        {
          type: "delivery.failed", owner_uid: 1000, subject: "proc:worker", idempotency_key: "notice-approval", created_at: 10_000,
          actor: { kind: "kernel" },
          body: { pid: "worker", runId: "run-1", requestId: "approval-1", message: "The approval notification stopped after 10 retry-safe delivery attempts: timeout" },
        },
        {
          type: "delivery.failed", owner_uid: 1000, subject: "proc:worker", idempotency_key: "notice-reply", created_at: 20_000,
          actor: { kind: "kernel" }, body: { pid: "worker", runId: "run-1", message: "The message could not be delivered: chat closed" },
        },
      ]);
      expect(sql.exec("SELECT seq, consumer, lane, state, attempt_count, next_attempt_at, last_error, updated_at FROM deliveries ORDER BY seq").toArray()).toEqual(
        events.map(({ seq, created_at }) => ({
          seq, consumer: "proc:worker", lane: "background", state: "pending", attempt_count: 0,
          next_attempt_at: created_at, last_error: null, updated_at: created_at,
        })),
      );
      expect(sql.exec("SELECT id FROM cf_agents_schedules ORDER BY id").toArray()).toEqual([{ id: "task:route" }]);
    });
  });
});
