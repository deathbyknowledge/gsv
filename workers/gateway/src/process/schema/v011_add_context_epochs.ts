import type { SqlMigration } from "../../schema/runner";

export const PROCESS_V011_ADD_CONTEXT_EPOCHS: SqlMigration = {
  id: 11,
  name: "add_context_epochs",
  statements: [
    `
      CREATE TABLE context_epochs (
        epoch_id TEXT PRIMARY KEY,
        generation INTEGER NOT NULL,
        system_prompt TEXT NOT NULL,
        r12y_revision INTEGER NOT NULL,
        r12y_count INTEGER NOT NULL,
        observed_r12y_revision INTEGER NOT NULL,
        r12y_baseline_json TEXT NOT NULL,
        source_manifest_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('live', 'closed')),
        created_at INTEGER NOT NULL,
        closed_at INTEGER,
        close_reason TEXT,
        archive_path TEXT
      )
    `,
    `
      CREATE UNIQUE INDEX context_epochs_live_idx
      ON context_epochs (state)
      WHERE state = 'live'
    `,
    `
      CREATE INDEX context_epochs_generation_idx
      ON context_epochs (generation, created_at)
    `,
    `
      CREATE TABLE context_epoch_transitions (
        epoch_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        transition_json TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (epoch_id, revision),
        FOREIGN KEY (epoch_id) REFERENCES context_epochs(epoch_id)
      )
    `,
    `
      CREATE INDEX context_epoch_transitions_message_idx
      ON context_epoch_transitions (message_id)
    `,
    `
      CREATE TABLE context_epoch_runs (
        epoch_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        finish_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (epoch_id, run_id),
        FOREIGN KEY (epoch_id) REFERENCES context_epochs(epoch_id)
      )
    `,
    `
      CREATE INDEX context_epoch_runs_created_idx
      ON context_epoch_runs (epoch_id, created_at, run_id)
    `,
  ],
};
