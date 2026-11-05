import { describe, expect, it } from "vitest";
import { runSqlMigrations } from "../../schema/runner";
import { runWithRealKernelSql } from "../../test-support/real-kernel-sql";
import { KERNEL_MIGRATIONS, KERNEL_SCHEMA_COMPONENT } from "./migrations";

/** Each test runs one shipped migration on the schema before it; v092 later moves calls' answers onto the event log. */
function migrateThrough(storage: DurableObjectStorage, id: number) {
  const through = KERNEL_MIGRATIONS.filter((migration) => migration.id <= id);
  runSqlMigrations(storage, KERNEL_SCHEMA_COMPONENT, through);
  runSqlMigrations(storage, KERNEL_SCHEMA_COMPONENT, through);
}

function insertCall(sql: SqlStorage, callId: string, status: string, error: string | null = null) {
  sql.exec(
    `INSERT INTO ipc_calls (call_id, uid, source_pid, source_run_id, target_pid, target_run_id, status, deadline_at, created_at, updated_at, error)
     VALUES (?, 1000, 'proc:ship', 'run:ship', ?, ?, ?, 100, 1, 1, ?)`,
    callId, `proc:target-${callId}`, `run:${callId}`, status, error,
  );
}

describe("IPC call migrations", () => {
  it("supervises only in-flight legacy delegations in v36", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      await storage.deleteAll();
      runSqlMigrations(storage, KERNEL_SCHEMA_COMPONENT, KERNEL_MIGRATIONS.filter((migration) => migration.id < 36));
      insertCall(sql, "delegated", "pending");
      insertCall(sql, "ordinary", "pending");
      insertCall(sql, "ended", "completed");
      for (const callId of ["delegated", "ended"]) {
        sql.exec(
          `INSERT INTO cf_agents_schedules (id, callback, payload, type, time, owner_path, owner_path_key)
           VALUES (?, 'onIpcCallTimeout', ?, 'scheduled', 1, NULL, NULL)`,
          crypto.randomUUID(), JSON.stringify({ callId, terminateTargetOnTimeout: true }),
        );
      }

      migrateThrough(storage, 36);

      expect(sql.exec("SELECT call_id, supervised FROM ipc_calls ORDER BY call_id").toArray()).toEqual([
        { call_id: "delegated", supervised: 1 },
        { call_id: "ended", supervised: 0 },
        { call_id: "ordinary", supervised: 0 },
      ]);
    });
  });

  it("backfills only recognized aborted completions in v68, leaving the rest of each call alone", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      await storage.deleteAll();
      runSqlMigrations(storage, KERNEL_SCHEMA_COMPONENT, KERNEL_MIGRATIONS.filter((migration) => migration.id < 68));
      const fixtures = [
        { callId: "aborted", status: "completed", error: "Target run was aborted", runStatus: "aborted" },
        { callId: "superseded", status: "completed", error: "Target run was aborted: user.superseded", runStatus: "aborted" },
        { callId: "failed", status: "completed", error: "Provider connection aborted unexpectedly", runStatus: null },
        { callId: "completed", status: "completed", error: null, runStatus: null },
        { callId: "pending", status: "pending", error: null, runStatus: null },
        { callId: "timed-out", status: "timed_out", error: "IPC call timed out", runStatus: null },
      ];
      for (const { callId, status, error } of fixtures) insertCall(sql, callId, status, error);
      const before = sql.exec("SELECT * FROM ipc_calls ORDER BY call_id").toArray();

      migrateThrough(storage, 68);

      expect(sql.exec("SELECT * FROM ipc_calls ORDER BY call_id").toArray()).toEqual(before.map((row) => ({
        ...row, run_status: fixtures.find(({ callId }) => callId === row.call_id)!.runStatus,
      })));
      expect(() => sql.exec("UPDATE ipc_calls SET run_status = 'unknown' WHERE call_id = 'pending'"))
        .toThrow(/CHECK constraint failed/);
    });
  });
});
