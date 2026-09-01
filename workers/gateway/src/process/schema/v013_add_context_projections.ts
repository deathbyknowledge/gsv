import type { SqlMigration } from "../../schema/runner";

export const PROCESS_V013_ADD_CONTEXT_PROJECTIONS: SqlMigration = {
  id: 13,
  name: "add_context_projections",
  statements: [
    `
      ALTER TABLE context_epochs
      ADD COLUMN observed_projection_json TEXT
    `,
    `
      CREATE TABLE context_epoch_message_refs (
        epoch_id TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (epoch_id, message_id),
        FOREIGN KEY (epoch_id) REFERENCES context_epochs(epoch_id)
      )
    `,
    `
      CREATE INDEX context_epoch_message_refs_message_idx
      ON context_epoch_message_refs (message_id)
    `,
  ],
};
