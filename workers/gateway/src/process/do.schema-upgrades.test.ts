import { PROCESS_V001_INITIAL_SCHEMA } from "./schema/v001_initial";
import { PROCESS_V004_PENDING_TOOL_DISPATCH_ID } from "./schema/v004_pending_tool_dispatch_id";
import { PROCESS_V005_TOOL_RESULT_OUTCOME } from "./schema/v005_tool_result_outcome";
import { PROCESS_V006_PENDING_HIL_OWNER } from "./schema/v006_pending_hil_owner";
import { PROCESS_V009_TYPED_MESSAGE_QUEUE } from "./schema/v009_typed_message_queue";
import { describe, expect, it } from "vitest";
import { runInProcess, ROOT_IDENTITY, initProcess } from "./do-test-harness";

describe("schema upgrades", () => {
  it("terminalizes provider HIL calls without inventing nested CodeMode results", async () => {
    const stub = await initProcess("mech-upgrade-v3-hil", ROOT_IDENTITY);

    await runInProcess(stub, (process) => {
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const sql = process.ctx.storage.sql as SqlStorage;
      const legacyToolTable = PROCESS_V001_INITIAL_SCHEMA.statements.find((statement) =>
        statement.includes("CREATE TABLE IF NOT EXISTS pending_tool_calls"),
      );
      const legacyHilTable = PROCESS_V001_INITIAL_SCHEMA.statements.find((statement) =>
        statement.includes("CREATE TABLE IF NOT EXISTS pending_hil"),
      );
      expect(legacyToolTable).toBeTruthy();
      expect(legacyHilTable).toBeTruthy();

      sql.exec("DROP TABLE pending_tool_calls");
      sql.exec("DROP TABLE pending_hil");
      sql.exec(legacyToolTable!);
      sql.exec(legacyHilTable!);
      sql.exec(
        `INSERT INTO pending_hil (
          request_id, run_id, conversation_id, generation, tool_call_id, tool_name,
          syscall, args_json, remaining_tool_calls_json, created_at
        ) VALUES (?, ?, 'default', 1, ?, 'Read', 'fs.read', ?, ?, 100)`,
        "request-upgrade",
        "run-upgrade",
        "call-current",
        JSON.stringify({ path: "/current" }),
        JSON.stringify([
          { type: "toolCall", id: "call-next", name: "Read", arguments: { path: "/next" } },
        ]),
      );
      sql.exec(
        `INSERT INTO pending_tool_calls (
          id, run_id, conversation_id, generation, call, args_json, status, created_at
        ) VALUES (?, ?, 'default', 1, 'codemode.exec', '{}', 'pending', 200)`,
        "call-codemode-outer",
        "run-codemode-upgrade",
      );
      sql.exec(
        `INSERT INTO pending_hil (
          request_id, run_id, conversation_id, generation, tool_call_id, tool_name,
          syscall, args_json, remaining_tool_calls_json, created_at
        ) VALUES (?, ?, 'default', 1, ?, 'Read', 'fs.read', ?, '[]', 201)`,
        "request-codemode-upgrade",
        "run-codemode-upgrade",
        "codemode-nested-call",
        JSON.stringify({ path: "/nested" }),
      );

      for (const statement of PROCESS_V004_PENDING_TOOL_DISPATCH_ID.statements) {
        sql.exec(statement);
      }

      const tools = sql
        .exec<{
          id: string;
          call: string;
          args_json: string;
          status: string;
          error: string;
        }>(
          `SELECT id, call, args_json, status, error
           FROM pending_tool_calls
          ORDER BY created_at ASC`,
        )
        .toArray();
      expect(tools).toEqual([
        {
          id: "call-current",
          call: "fs.read",
          args_json: JSON.stringify({ path: "/current" }),
          status: "error",
          error: "Tool approval interrupted by the 0.4 upgrade",
        },
        {
          id: "call-next",
          call: "Read",
          args_json: JSON.stringify({ path: "/next" }),
          status: "error",
          error: "Tool approval interrupted by the 0.4 upgrade",
        },
        {
          id: "call-codemode-outer",
          call: "codemode.exec",
          args_json: "{}",
          status: "error",
          error: "Tool execution interrupted by the 0.4 upgrade",
        },
      ]);
      expect(
        sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM pending_hil").toArray()[0]
          ?.count,
      ).toBe(0);
      expect(
        sql
          .exec<{ name: string }>("PRAGMA table_info(pending_hil)")
          .toArray()
          .map((column) => column.name),
      ).not.toContain("remaining_tool_calls_json");
    });
  });

  it("backfills terminal tool outcomes when upgrading from v4", async () => {
    const stub = await initProcess("mech-upgrade-v4-outcomes", ROOT_IDENTITY);

    await runInProcess(stub, (process) => {
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const sql = process.ctx.storage.sql as SqlStorage;
      sql.exec("ALTER TABLE pending_tool_calls DROP COLUMN outcome");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const rows = [
        ["completed", JSON.stringify({ status: "completed" }), null, "completed"],
        ["failed-envelope", JSON.stringify({ status: "failed" }), null, "completed"],
        ["denied", null, "Tool execution denied by user", "error"],
        ["failed-error", null, "provider failure", "error"],
        // SAFETY: test fixture is constructed with the asserted domain shape.
      ] as const;
      rows.forEach(([id, result, error, status], index) => {
        sql.exec(
          `INSERT INTO pending_tool_calls (
            dispatch_id, id, run_id, call, args_json,
            result_json, error, status, created_at
          ) VALUES (?, ?, 'run-upgrade-outcomes', 'fs.read', '{}', ?, ?, ?, ?)`,
          `dispatch-${id}`,
          id,
          result,
          error,
          status,
          index,
        );
      });

      for (const statement of PROCESS_V005_TOOL_RESULT_OUTCOME.statements) {
        sql.exec(statement);
      }

      expect(
        sql
          .exec<{ id: string; outcome: string }>(
            "SELECT id, outcome FROM pending_tool_calls ORDER BY created_at ASC",
          )
          .toArray(),
      ).toEqual([
        { id: "completed", outcome: "completed" },
        { id: "failed-envelope", outcome: "failed" },
        { id: "denied", outcome: "denied" },
        { id: "failed-error", outcome: "failed" },
      ]);
    });
  });

  it("recovers only unambiguous CodeMode approval owners when upgrading from v5", async () => {
    const stub = await initProcess("mech-upgrade-v5-hil-owner", ROOT_IDENTITY);

    await runInProcess(stub, (process) => {
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const sql = process.ctx.storage.sql as SqlStorage;
      sql.exec("ALTER TABLE pending_hil DROP COLUMN owner_dispatch_id");
      const insertTool = (
        dispatchId: string,
        id: string,
        runId: string,
        call: string,
        status: string,
        createdAt: number,
      ) =>
        sql.exec(
          `INSERT INTO pending_tool_calls (
          dispatch_id, id, run_id, call, args_json,
          status, created_at
        ) VALUES (?, ?, ?, ?, '{}', ?, ?)`,
          dispatchId,
          id,
          runId,
          call,
          status,
          createdAt,
        );
      const insertHil = (requestId: string, runId: string, toolCallId: string) =>
        sql.exec(
          `INSERT INTO pending_hil (
          request_id, run_id, tool_call_id, tool_name,
          syscall, args_json, created_at
        ) VALUES (?, ?, ?, 'Read', 'fs.read', '{}', 1)`,
          requestId,
          runId,
          toolCallId,
        );

      insertTool("dispatch-direct", "call-direct", "run-direct", "fs.read", "registered", 1);
      insertHil("hil-direct", "run-direct", "call-direct");
      insertTool("dispatch-single", "call-single", "run-single", "codemode.exec", "pending", 2);
      insertHil("hil-single", "run-single", "nested-single");
      insertTool("dispatch-multi-a", "call-multi-a", "run-multi", "codemode.exec", "pending", 3);
      insertTool("dispatch-multi-b", "call-multi-b", "run-multi", "codemode.exec", "pending", 4);
      insertHil("hil-multi", "run-multi", "nested-multi");

      for (const statement of PROCESS_V006_PENDING_HIL_OWNER.statements) {
        sql.exec(statement);
      }

      expect(
        sql
          .exec<{ request_id: string; owner_dispatch_id: string | null }>(
            "SELECT request_id, owner_dispatch_id FROM pending_hil ORDER BY request_id ASC",
          )
          .toArray(),
      ).toEqual([
        { request_id: "hil-direct", owner_dispatch_id: null },
        { request_id: "hil-single", owner_dispatch_id: "dispatch-single" },
      ]);
      expect(
        sql
          .exec<{ id: string; status: string; outcome: string | null }>(
            `SELECT id, status, outcome
           FROM pending_tool_calls
          WHERE run_id = 'run-multi'
          ORDER BY created_at ASC`,
          )
          .toArray(),
      ).toEqual([
        { id: "call-multi-a", status: "error", outcome: "failed" },
        { id: "call-multi-b", status: "error", outcome: "failed" },
      ]);
    });
  });

  it("preserves legacy user work and restores queued runtime event roles when upgrading from v8", async () => {
    const stub = await initProcess("mech-upgrade-v8-queue", ROOT_IDENTITY);

    await runInProcess(stub, (process) => {
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const sql = process.ctx.storage.sql as SqlStorage;
      sql.exec("ALTER TABLE message_queue DROP COLUMN provenance_json");
      sql.exec("ALTER TABLE message_queue DROP COLUMN kind");
      sql.exec("ALTER TABLE message_queue DROP COLUMN role");
      sql.exec(
        `INSERT INTO message_queue (
          run_id, generation, message, origin_json, created_at
        ) VALUES (?, 1, ?, ?, 1)`,
        "run-user",
        "ordinary queued work",
        JSON.stringify({ kind: "process", sourcePid: "child" }),
      );
      sql.exec(
        `INSERT INTO message_queue (
          run_id, generation, message, origin_json, created_at
        ) VALUES (?, 1, ?, ?, 2)`,
        "run-schedule",
        "scheduled work",
        JSON.stringify({ kind: "scheduler", scheduleId: "sched-1" }),
      );
      sql.exec(
        `INSERT INTO message_queue (
          run_id, generation, message, created_at
        ) VALUES (?, 1, ?, 3)`,
        "run-wake",
        "A runtime event arrived while you were busy. Review the process event above and continue.",
      );

      for (const statement of PROCESS_V009_TYPED_MESSAGE_QUEUE.statements) {
        sql.exec(statement);
      }

      const rows = sql
        .exec<{
          run_id: string;
          role: string;
          kind: string;
          provenance_json: string | null;
        }>(
          `SELECT run_id, role, kind, provenance_json
           FROM message_queue
          ORDER BY created_at ASC`,
        )
        .toArray();
      expect(rows[0]).toEqual({
        run_id: "run-user",
        role: "user",
        kind: "message",
        provenance_json: null,
      });
      expect(rows[1]).toMatchObject({
        run_id: "run-schedule",
        role: "system",
        kind: "schedule.event",
      });
      expect(JSON.parse(rows[1]!.provenance_json!)).toEqual({
        source: "kernel",
        eventId: "run-schedule",
        eventType: "schedule.event",
      });
      expect(rows[2]).toMatchObject({
        run_id: "run-wake",
        role: "system",
        kind: "runtime.wake",
      });
      expect(JSON.parse(rows[2]!.provenance_json!)).toEqual({
        source: "process",
        eventType: "runtime.wake",
      });
    });
  });
});
