import type { InferenceSqlMigration } from "./migrations";

export const INFERENCE_V001_INITIAL_SCHEMA: InferenceSqlMigration = {
  id: 1,
  name: "initial_inference_schema",
  statements: [
    `
      CREATE TABLE IF NOT EXISTS inference_periods (
        period                  TEXT PRIMARY KEY,
        spent_nano_usd          INTEGER NOT NULL DEFAULT 0,
        reserved_nano_usd       INTEGER NOT NULL DEFAULT 0,
        started_requests        INTEGER NOT NULL DEFAULT 0,
        completed_requests      INTEGER NOT NULL DEFAULT 0,
        failed_requests         INTEGER NOT NULL DEFAULT 0,
        aborted_requests        INTEGER NOT NULL DEFAULT 0,
        abandoned_requests      INTEGER NOT NULL DEFAULT 0
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS inference_requests (
        logical_request_id      TEXT PRIMARY KEY,
        local_uid               INTEGER NOT NULL,
        process_id              TEXT,
        run_id                  TEXT,
        period                  TEXT NOT NULL REFERENCES inference_periods(period),
        model                   TEXT NOT NULL,
        state                   TEXT NOT NULL CHECK (state IN (
          'reserved', 'completed', 'failed', 'aborted', 'abandoned'
        )),
        reserved_nano_usd       INTEGER NOT NULL,
        cost_nano_usd           INTEGER,
        input_tokens            INTEGER,
        output_tokens           INTEGER,
        cache_read_tokens       INTEGER,
        cache_write_tokens      INTEGER,
        total_tokens            INTEGER,
        response_model          TEXT,
        provider_response_id    TEXT,
        stop_reason             TEXT,
        started_at              INTEGER NOT NULL,
        reservation_expires_at  INTEGER NOT NULL,
        completed_at            INTEGER,
        exported_at             INTEGER,
        export_attempts         INTEGER NOT NULL DEFAULT 0,
        next_export_at          INTEGER
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS inference_requests_export_idx
      ON inference_requests(exported_at, next_export_at, completed_at)
    `,
    `
      CREATE INDEX IF NOT EXISTS inference_requests_expiry_idx
      ON inference_requests(state, reservation_expires_at)
    `,
  ],
};
