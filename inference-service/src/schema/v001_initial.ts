import type { SqlMigration } from "./runner";

export const INFERENCE_V001_INITIAL: SqlMigration = {
  id: 1,
  name: "initial_inference_budget",
  statements: [
    "PRAGMA foreign_keys = ON",
    `
      CREATE TABLE budget_periods (
        period_start             INTEGER PRIMARY KEY,
        period_end               INTEGER NOT NULL,
        entitlement_version      INTEGER NOT NULL,
        budget_microunits        INTEGER NOT NULL,
        spent_microunits         INTEGER NOT NULL DEFAULT 0,
        reserved_microunits      INTEGER NOT NULL DEFAULT 0,
        created_at               INTEGER NOT NULL,
        updated_at               INTEGER NOT NULL,
        CHECK (period_end > period_start),
        CHECK (budget_microunits >= 0),
        CHECK (spent_microunits >= 0),
        CHECK (reserved_microunits >= 0)
      )
    `,
    `
      CREATE TABLE daily_budgets (
        day_start                INTEGER NOT NULL,
        period_start             INTEGER NOT NULL,
        budget_microunits        INTEGER NOT NULL,
        spent_microunits         INTEGER NOT NULL DEFAULT 0,
        reserved_microunits      INTEGER NOT NULL DEFAULT 0,
        created_at               INTEGER NOT NULL,
        updated_at               INTEGER NOT NULL,
        PRIMARY KEY (day_start, period_start),
        FOREIGN KEY (period_start) REFERENCES budget_periods(period_start),
        CHECK (budget_microunits >= 0),
        CHECK (spent_microunits >= 0),
        CHECK (reserved_microunits >= 0)
      )
    `,
    `
      CREATE TABLE inference_requests (
        logical_request_id       TEXT PRIMARY KEY,
        request_fingerprint      TEXT NOT NULL,
        actor_uid                INTEGER NOT NULL,
        process_id               TEXT,
        run_id                   TEXT,
        period_start             INTEGER NOT NULL,
        state                    TEXT NOT NULL CHECK (state IN (
          'admitted', 'running', 'succeeded', 'failed', 'aborted', 'ambiguous'
        )),
        attempt_count            INTEGER NOT NULL DEFAULT 0,
        spent_microunits         INTEGER NOT NULL DEFAULT 0,
        created_at               INTEGER NOT NULL,
        updated_at               INTEGER NOT NULL,
        FOREIGN KEY (period_start) REFERENCES budget_periods(period_start),
        CHECK (actor_uid >= 0),
        CHECK (attempt_count >= 0),
        CHECK (spent_microunits >= 0)
      )
    `,
    `
      CREATE TABLE provider_attempts (
        attempt_id               TEXT PRIMARY KEY,
        logical_request_id       TEXT NOT NULL,
        ordinal                  INTEGER NOT NULL,
        provider                 TEXT NOT NULL,
        model_revision           TEXT NOT NULL,
        price_book_version       TEXT NOT NULL,
        day_start                INTEGER NOT NULL,
        state                    TEXT NOT NULL CHECK (state IN (
          'admitted', 'running', 'succeeded', 'failed', 'aborted', 'ambiguous'
        )),
        reserved_microunits      INTEGER NOT NULL,
        settled_microunits       INTEGER,
        cache_hit_input_tokens   INTEGER,
        cache_miss_input_tokens  INTEGER,
        output_tokens            INTEGER,
        started_at               INTEGER,
        deadline_at              INTEGER NOT NULL,
        finished_at              INTEGER,
        FOREIGN KEY (logical_request_id) REFERENCES inference_requests(logical_request_id),
        UNIQUE (logical_request_id, ordinal),
        CHECK (ordinal > 0),
        CHECK (reserved_microunits >= 0),
        CHECK (settled_microunits IS NULL OR settled_microunits >= 0)
      )
    `,
    `
      CREATE INDEX provider_attempts_active_idx
      ON provider_attempts (state, deadline_at)
    `,
    `
      CREATE INDEX provider_attempts_request_idx
      ON provider_attempts (logical_request_id, ordinal)
    `,
  ],
};
