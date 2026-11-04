import { describe, expect, it } from "vitest";
import { runSqlMigrations } from "../../schema/runner";
import { runWithRealKernelSql } from "../../test-support/real-kernel-sql";
import { IpcCallStore } from "../ipc-calls";
import { KERNEL_MIGRATIONS, KERNEL_SCHEMA_COMPONENT, runKernelSqlMigrations } from "./migrations";

const CALLER = "ship-pid";
const TARGET = "worker-pid";

describe("IPC answers migration", () => {
  it("moves answers still on their way to their callers into the log, leaving pending calls with their targets", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      await storage.deleteAll();
      runSqlMigrations(storage, KERNEL_SCHEMA_COMPONENT, KERNEL_MIGRATIONS.filter((migration) => migration.id < 98));
      const calls = new IpcCallStore(sql);
      const fixtures = [
        // Answered by the target's run, and in flight to the caller when the Kernel stopped.
        { callId: "replied", status: "completed", error: null, runStatus: "ok", response: { text: "done", usage: null }, updatedAt: 30, deliveryStartedAt: 25 },
        // Ended by the Kernel when the target was reset.
        { callId: "reset", status: "completed", error: "Target process was reset", runStatus: null, response: null, updatedAt: 20, deliveryStartedAt: null },
        { callId: "late", status: "timed_out", error: "IPC call timed out", runStatus: null, response: null, updatedAt: 10, deliveryStartedAt: null },
        { callId: "pending", status: "pending", error: null, runStatus: null, response: null, updatedAt: 5, deliveryStartedAt: null },
      ];
      for (const { callId, status, error, runStatus, response, updatedAt, deliveryStartedAt } of fixtures) {
        calls.create({
          callId, uid: 1000, sourcePid: CALLER, sourceRunId: "run:ship",
          targetPid: TARGET, targetRunId: `run:${callId}`, deadlineAt: 100,
        });
        sql.exec(
          `UPDATE ipc_calls SET status = ?, error = ?, run_status = ?, response_json = ?, updated_at = ?, delivery_started_at = ?
           WHERE call_id = ?`,
          status, error, runStatus, JSON.stringify(response), updatedAt, deliveryStartedAt, callId,
        );
      }
      const insertTask = "INSERT INTO cf_agents_schedules (id, callback, payload, type, time) VALUES (?, ?, ?, 'scheduled', 1)";
      sql.exec(insertTask, "task:delivery", "onIpcCallDelivery", JSON.stringify({ callId: "replied" }));
      sql.exec(insertTask, "task:timeout", "onIpcCallTimeout", JSON.stringify({ callId: "pending" }));

      runKernelSqlMigrations(storage);
      runKernelSqlMigrations(storage);

      const events = sql.exec<{ seq: number; type: string; owner_uid: number; subject: string; actor_json: string; idempotency_key: string; body_json: string; created_at: number }>(
        "SELECT * FROM events ORDER BY seq",
      ).toArray();
      // The log reads each answer from its call's row when it delivers, so the body only names the call.
      expect(events.map(({ seq: _seq, actor_json, body_json, ...row }) => ({ ...row, actor: JSON.parse(actor_json), body: JSON.parse(body_json) }))).toEqual([
        {
          type: "ipc.timeout", owner_uid: 1000, subject: "ipc:late", idempotency_key: "late", created_at: 10,
          actor: { kind: "kernel" }, body: { callId: "late", sourcePid: CALLER },
        },
        {
          type: "ipc.reply", owner_uid: 1000, subject: "ipc:reset", idempotency_key: "reset", created_at: 20,
          actor: { kind: "kernel" }, body: { callId: "reset", sourcePid: CALLER },
        },
        {
          type: "ipc.reply", owner_uid: 1000, subject: "ipc:replied", idempotency_key: "replied", created_at: 30,
          actor: { kind: "process", pid: TARGET }, body: { callId: "replied", sourcePid: CALLER },
        },
      ]);
      expect(sql.exec("SELECT seq, consumer, lane, state, attempt_count, next_attempt_at, last_error, updated_at FROM deliveries ORDER BY seq").toArray()).toEqual(
        events.map(({ seq, created_at }) => ({
          seq, consumer: `proc:${CALLER}`, lane: "background", state: "pending", attempt_count: 0,
          next_attempt_at: created_at, last_error: null, updated_at: created_at,
        })),
      );
      // Every call keeps its row until its answer's delivery ends; the pending one is still with its target.
      expect(sql.exec("SELECT call_id, status FROM ipc_calls ORDER BY call_id").toArray()).toEqual([
        { call_id: "late", status: "timed_out" },
        { call_id: "pending", status: "pending" },
        { call_id: "replied", status: "completed" },
        { call_id: "reset", status: "completed" },
      ]);
      expect(sql.exec("SELECT name FROM pragma_table_info('ipc_calls') WHERE name = 'delivery_started_at'").toArray()).toEqual([]);
      expect(sql.exec("SELECT id FROM cf_agents_schedules ORDER BY id").toArray()).toEqual([{ id: "task:timeout" }]);
    });
  });
});
