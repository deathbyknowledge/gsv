import type { ProcessStore } from "../store";
import {
  type JsonValue, type ProcToolResultOutcome, type ProcTraceSpanStatus, jsonObjectSchema, jsonValueSchema,
} from "@humansandmachines/gsv/protocol";
import { isToolSyscallName, syscallToolName } from "../../syscalls/constants";
import {
  normalizeStoredToolResultOutcome, resolvedToolResultOutcome, toolCallStatusSchema, type PendingHilRecord,
  type PendingToolCallRecord, type ToolCallRecord,
} from "./store-codecs";

/** Owns pending tool executions and human-in-the-loop approvals. */
export class ProcessToolRepository {
  constructor(private readonly store: ProcessStore) { }

  // --- Tool calls ---

  register(
    dispatchId: string,
    id: string,
    runId: string,
    call: string,
    args: JsonValue,
  ): void {
    const createdAt = Date.now();
    this.store.sql.exec(
      `INSERT INTO pending_tool_calls (
        dispatch_id, id, run_id, call, args_json, status, created_at
      ) VALUES (?, ?, ?, ?, ?, 'registered', ?)`,
      dispatchId,
      id,
      runId,
      call,
      JSON.stringify(args),
      createdAt,
    );
    this.store.traces.startTraceSpan({
      id: `tool:${dispatchId}`,
      runId,
      parentId: `run:${runId}`,
      kind: "tool",
      name: syscallToolName(call) ?? call,
      startedAt: createdAt,
      reference: { kind: "tool", callId: id, executionId: dispatchId },
      attributes: { syscall: call },
    });
  }

  resolve(
    dispatchId: string,
    result: JsonValue,
    outcome: "completed" | "failed" = resolvedToolResultOutcome(result),
  ): boolean {
    const cursor = this.store.sql.exec(
      `UPDATE pending_tool_calls
          SET status = 'completed', result_json = ?, outcome = ?
        WHERE dispatch_id = ? AND status IN ('registered', 'pending')`,
      JSON.stringify(result ?? null),
      outcome,
      dispatchId,
    );
    if (cursor.rowsWritten > 0) {
      const status = outcome === "completed" ? "ok" : "error";
      this.finishSpans(dispatchId, status);
    }
    return cursor.rowsWritten > 0;
  }

  fail(
    dispatchId: string,
    error: string,
    outcome: Exclude<ProcToolResultOutcome, "completed"> = "failed",
  ): boolean {
    const cursor = this.store.sql.exec(
      `UPDATE pending_tool_calls
          SET status = 'error', error = ?, outcome = ?
        WHERE dispatch_id = ? AND status IN ('registered', 'pending')`,
      error,
      outcome,
      dispatchId,
    );
    if (cursor.rowsWritten > 0) {
      const status = outcome === "cancelled"
        ? "aborted"
        : outcome === "denied"
          ? "denied"
          : "error";
      this.finishSpans(dispatchId, status);
    }
    return cursor.rowsWritten > 0;
  }

  private finishSpans(
    dispatchId: string,
    status: Exclude<ProcTraceSpanStatus, "running">,
  ): void {
    const endedAt = Date.now();
    this.store.traces.finishTraceSpan(`execution:${dispatchId}`, status, endedAt);
    this.store.traces.finishTraceSpan(`tool:${dispatchId}`, status, endedAt);
  }

  markDispatched(dispatchId: string): boolean {
    const cursor = this.store.sql.exec(
      `UPDATE pending_tool_calls
          SET status = 'pending'
        WHERE dispatch_id = ? AND status = 'registered'`,
      dispatchId,
    );
    if (cursor.rowsWritten > 0) {
      const record = this.store.first<{
        id: string;
        run_id: string;
        call: string;
      }>(
        "SELECT id, run_id, call FROM pending_tool_calls WHERE dispatch_id = ?",
        dispatchId,
      );
      if (record) {
        this.store.traces.startTraceSpan({
          id: `execution:${dispatchId}`,
          runId: record.run_id,
          parentId: `tool:${dispatchId}`,
          kind: "tool",
          name: "Execute",
          startedAt: Date.now(),
          reference: {
            kind: "tool",
            callId: record.id,
            executionId: dispatchId,
          },
          attributes: { syscall: record.call },
        });
      }
    }
    return cursor.rowsWritten > 0;
  }

  getPending(dispatchId: string): PendingToolCallRecord | null {
    const row = this.store.first<{
      id: string;
      run_id: string;
      call: string;
      args_json: string | null;
      status: "registered" | "pending";
    }>(
      `SELECT id, run_id, call, args_json, status
         FROM pending_tool_calls
        WHERE dispatch_id = ? AND status IN ('registered', 'pending')`,
      dispatchId,
    );
    if (!row) return null;
    return {
      runId: row.run_id,
      callId: row.id,
      call: row.call,
      args: row.args_json
        ? jsonValueSchema.parse(JSON.parse(row.args_json))
        : null,
      status: row.status,
    };
  }

  isRunResolved(runId: string): boolean {
    const count = this.store.first<{ cnt: number }>(
      `SELECT COUNT(*) as cnt
         FROM pending_tool_calls
        WHERE run_id = ? AND status IN ('registered', 'pending')`,
      runId,
    )?.cnt ?? 0;
    return count === 0;
  }

  getResults(runId: string): ToolCallRecord[] {
    return [...this.store.sql.exec<{
      id: string;
      dispatch_id: string;
      call: string;
      args_json: string;
      status: string;
      result_json: string | null;
      error: string | null;
      outcome: string | null;
    }>(
      `SELECT id, dispatch_id, call, args_json, status, result_json, error, outcome
         FROM pending_tool_calls
        WHERE run_id = ?
        ORDER BY created_at ASC, rowid ASC`,
      runId,
    )].map((row) => ({
      id: row.id,
      dispatchId: row.dispatch_id,
      call: row.call,
      args: jsonValueSchema.parse(JSON.parse(row.args_json)),
      status: toolCallStatusSchema.parse(row.status),
      result: row.result_json
        ? jsonValueSchema.parse(JSON.parse(row.result_json))
        : null,
      error: row.error,
      outcome: normalizeStoredToolResultOutcome(row.outcome),
    }));
  }

  clearRun(runId: string): void {
    this.store.sql.exec("DELETE FROM pending_tool_calls WHERE run_id = ?", runId);
  }

  clearPendingToolCalls(): void {
    this.store.sql.exec("DELETE FROM pending_tool_calls");
  }

  setPendingHil(record: PendingHilRecord): void {
    this.clearPendingHil();
    this.store.sql.exec(
      `INSERT INTO pending_hil (
        request_id, run_id, owner_dispatch_id, tool_call_id,
        tool_name, syscall, args_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      record.requestId,
      record.runId,
      record.ownerDispatchId ?? null,
      record.toolCallId,
      record.toolName,
      record.syscall,
      JSON.stringify(record.args),
      record.createdAt,
    );
    const dispatchId = record.ownerDispatchId ?? this.store.first<{ dispatch_id: string }>(
      `SELECT dispatch_id FROM pending_tool_calls
       WHERE run_id = ? AND id = ?
       ORDER BY created_at DESC LIMIT 1`,
      record.runId,
      record.toolCallId,
    )?.dispatch_id;
    this.store.traces.startTraceSpan({
      id: `approval:${record.requestId}`,
      runId: record.runId,
      parentId: dispatchId ? `tool:${dispatchId}` : `run:${record.runId}`,
      kind: "approval",
      name: `Approve ${record.toolName}`,
      startedAt: record.createdAt,
      reference: {
        kind: "approval",
        requestId: record.requestId,
        callId: record.toolCallId,
      },
      attributes: {
        syscall: record.syscall,
      },
    });
  }

  getPendingHil(requestId?: string): PendingHilRecord | null {
    const row = this.store.first<{
        request_id: string;
        run_id: string;
        owner_dispatch_id: string | null;
        tool_call_id: string;
        tool_name: string;
        syscall: string;
        args_json: string;
        created_at: number;
      }>(
        requestId
          ? `SELECT * FROM pending_hil WHERE request_id = ? ORDER BY created_at ASC LIMIT 1`
          : `SELECT * FROM pending_hil ORDER BY created_at ASC LIMIT 1`,
        ...(requestId ? [requestId] : []),
      );
    if (!row) return null;
    if (!isToolSyscallName(row.syscall)) {
      throw new Error(`Stored approval references an unsupported syscall: ${row.syscall}`);
    }
    const record: PendingHilRecord = {
      requestId: row.request_id,
      runId: row.run_id,
      toolCallId: row.tool_call_id,
      toolName: row.tool_name,
      syscall: row.syscall,
      args: jsonObjectSchema.parse(JSON.parse(row.args_json)),
      createdAt: row.created_at,
    };
    if (row.owner_dispatch_id) {
      record.ownerDispatchId = row.owner_dispatch_id;
    }
    return record;
  }

  getPendingHilForRun(runId: string): PendingHilRecord | null {
    const record = this.getPendingHil();
    if (!record || record.runId !== runId) {
      return null;
    }
    return record;
  }

  clearPendingHil(
    status: Exclude<ProcTraceSpanStatus, "running"> = "aborted",
  ): void {
    const approvals = this.store.sql.exec<{ request_id: string; }>(
      "SELECT request_id FROM pending_hil",
    ).toArray();
    this.store.sql.exec("DELETE FROM pending_hil");
    const endedAt = Date.now();
    for (const approval of approvals) {
      this.store.traces.finishTraceSpan(`approval:${approval.request_id}`, status, endedAt);
    }
  }
}
