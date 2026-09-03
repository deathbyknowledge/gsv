import type { ProcessStore } from "../store";
import type {
  JsonObject, ProcTraceSpanKind, ProcTraceSpanReference, ProcTraceSpanStatus,
} from "@humansandmachines/gsv/protocol";
import {
  MAX_TRACE_RUNS, MAX_TRACE_SPANS_PER_RUN, processTraceSpanFromRow, type ProcessTraceSpanList,
  type ProcessTraceSpanRow,
} from "./store-codecs";

/** Owns bounded Process trace spans and their terminal transitions. */
export class ProcessTraceRepository {
  constructor(private readonly store: ProcessStore) { }

  startTraceSpan(input: {
    id: string;
    runId: string;
    parentId?: string;
    kind: ProcTraceSpanKind;
    name: string;
    startedAt: number;
    reference?: ProcTraceSpanReference;
    attributes?: JsonObject;
  }): boolean {
    const count = this.store.first<{ count: number }>(
      "SELECT COUNT(*) AS count FROM process_trace_spans WHERE run_id = ?",
      input.runId,
    )?.count ?? 0;
    if (count >= MAX_TRACE_SPANS_PER_RUN) return false;

    const cursor = this.store.sql.exec(
      `INSERT OR IGNORE INTO process_trace_spans (
        span_id, run_id, parent_span_id, kind, name, status,
        started_at, ended_at, reference_json, attributes_json
      ) VALUES (?, ?, ?, ?, ?, 'running', ?, NULL, ?, ?)`,
      input.id,
      input.runId,
      input.parentId ?? null,
      input.kind,
      input.name,
      input.startedAt,
      input.reference ? JSON.stringify(input.reference) : null,
      input.attributes ? JSON.stringify(input.attributes) : null,
    );
    return cursor.rowsWritten > 0;
  }

  finishTraceSpan(
    id: string,
    status: Exclude<ProcTraceSpanStatus, "running">,
    endedAt: number,
    options: {
      reference?: ProcTraceSpanReference;
      attributes?: JsonObject;
    } = {},
  ): boolean {
    const cursor = this.store.sql.exec(
      `UPDATE process_trace_spans
       SET status = ?, ended_at = ?,
           reference_json = COALESCE(?, reference_json),
           attributes_json = COALESCE(?, attributes_json)
       WHERE span_id = ? AND status = 'running'`,
      status,
      endedAt,
      options.reference ? JSON.stringify(options.reference) : null,
      options.attributes ? JSON.stringify(options.attributes) : null,
      id,
    );
    return cursor.rowsWritten > 0;
  }

  setTraceSpanReference(id: string, reference: ProcTraceSpanReference): void {
    this.store.sql.exec(
      "UPDATE process_trace_spans SET reference_json = ? WHERE span_id = ?",
      JSON.stringify(reference),
      id,
    );
  }

  finishRunTrace(
    runId: string,
    status: Exclude<ProcTraceSpanStatus, "running" | "denied">,
    endedAt: number,
  ): void {
    this.store.sql.exec(
      `UPDATE process_trace_spans
       SET status = ?, ended_at = ?
       WHERE run_id = ? AND status = 'running' AND kind != 'run'`,
      status === "ok" ? "aborted" : status,
      endedAt,
      runId,
    );
    this.finishTraceSpan(`run:${runId}`, status, endedAt);
    this.pruneTraceRuns();
  }

  getRunTraceStartedAt(runId: string): number | null {
    return this.store.first<{ started_at: number }>(
      `SELECT started_at FROM process_trace_spans
       WHERE span_id = ? AND run_id = ? AND kind = 'run'
       LIMIT 1`,
      `run:${runId}`,
      runId,
    )?.started_at ?? null;
  }

  listTraceSpans(options: { runId?: string; limit: number; }): ProcessTraceSpanList {
    const filter = options.runId ? "WHERE run_id = ?" : "";
    const args = options.runId ? [options.runId] : [];
    const count = this.store.first<{ count: number }>(
      `SELECT COUNT(*) AS count FROM process_trace_spans ${filter}`,
      ...args,
    )?.count ?? 0;
    const rows = this.store.sql.exec<ProcessTraceSpanRow>(
      `SELECT * FROM process_trace_spans ${filter}
       ORDER BY started_at DESC, span_id DESC
       LIMIT ?`,
      ...args,
      options.limit,
    ).toArray().reverse();
    return {
      count,
      spans: rows.map(processTraceSpanFromRow),
    };
  }

  clearTraceSpans(): void {
    this.store.sql.exec("DELETE FROM process_trace_spans");
  }

  private pruneTraceRuns(): void {
    this.store.sql.exec(
      `DELETE FROM process_trace_spans
       WHERE run_id NOT IN (
         SELECT run_id
         FROM process_trace_spans
         GROUP BY run_id
         ORDER BY MIN(started_at) DESC, run_id DESC
         LIMIT ?
       )`,
      MAX_TRACE_RUNS,
    );
  }
}
