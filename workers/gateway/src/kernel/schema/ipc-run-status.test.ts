import { describe, expect, it } from "vitest";
import { runSqlMigrations } from "../../schema/runner";
import { runWithRealKernelSql } from "../../test-support/real-kernel-sql";
import { IpcCallStore } from "../ipc-calls";
import { KERNEL_MIGRATIONS, KERNEL_SCHEMA_COMPONENT } from "./migrations";

describe("IPC run status migration", () => {
  it("backfills only recognized aborted completions, leaving the rest of each call alone", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      await storage.deleteAll();
      runSqlMigrations(storage, KERNEL_SCHEMA_COMPONENT, KERNEL_MIGRATIONS.filter((migration) => migration.id < 68));
      const calls = new IpcCallStore(sql);
      const fixtures = [
        { callId: "aborted", status: "completed", error: "Target run was aborted", runStatus: "aborted" },
        { callId: "superseded", status: "completed", error: "Target run was aborted: user.superseded", runStatus: "aborted" },
        { callId: "failed", status: "completed", error: "Provider connection aborted unexpectedly", runStatus: null },
        { callId: "completed", status: "completed", error: null, runStatus: null },
        { callId: "pending", status: "pending", error: null, runStatus: null },
        { callId: "timed-out", status: "timed_out", error: "IPC call timed out", runStatus: null },
      ];
      for (const { callId, status, error } of fixtures) {
        calls.create({
          callId, uid: 1000, sourcePid: "proc:ship", sourceRunId: "run:ship",
          targetPid: "proc:worker", targetRunId: `run:${callId}`, deadlineAt: 100,
        });
        sql.exec("UPDATE ipc_calls SET status = ?, error = ?, delivery_started_at = 50 WHERE call_id = ?", status, error, callId);
      }
      const before = sql.exec("SELECT * FROM ipc_calls ORDER BY call_id").toArray();

      // v092 later moves calls' answers onto the event log; this checks v068 on its own.
      const throughV068 = KERNEL_MIGRATIONS.filter((migration) => migration.id <= 68);
      runSqlMigrations(storage, KERNEL_SCHEMA_COMPONENT, throughV068);
      runSqlMigrations(storage, KERNEL_SCHEMA_COMPONENT, throughV068);

      expect(sql.exec("SELECT * FROM ipc_calls ORDER BY call_id").toArray()).toEqual(before.map((row) => ({
        ...row, run_status: fixtures.find(({ callId }) => callId === row.call_id)!.runStatus,
      })));
      expect(calls.get("superseded")).toMatchObject({
        runStatus: "aborted", status: "completed", error: "Target run was aborted: user.superseded",
      });
      expect(() => sql.exec("UPDATE ipc_calls SET run_status = 'unknown' WHERE call_id = 'pending'"))
        .toThrow(/CHECK constraint failed/);
    });
  });
});
