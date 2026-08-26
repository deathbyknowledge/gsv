import type { SqlMigration } from "../../schema/runner";

export const PROCESS_V012_ADD_PROCESS_TRACE: SqlMigration = {
  id: 12,
  name: "add_process_trace",
  statements: [
    `
      CREATE TABLE process_trace_spans (
        span_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        parent_span_id TEXT,
        kind TEXT NOT NULL CHECK (kind IN (
          'run', 'context', 'inference', 'reasoning', 'output',
          'tool', 'approval', 'delivery'
        )),
        name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN (
          'running', 'ok', 'error', 'aborted', 'denied'
        )),
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        reference_json TEXT,
        attributes_json TEXT
      )
    `,
    `
      CREATE INDEX process_trace_spans_run_idx
      ON process_trace_spans (run_id, started_at, span_id)
    `,
    `
      CREATE INDEX process_trace_spans_started_idx
      ON process_trace_spans (started_at, span_id)
    `,
  ],
};
