import type { InferenceSqlMigration } from "./migrations";

export const INFERENCE_V003_CANCELLATION_TOMBSTONES: InferenceSqlMigration = {
  id: 3,
  name: "inference_cancellation_tombstones",
  statements: [
    `
      CREATE TABLE inference_cancellations (
        logical_request_id TEXT PRIMARY KEY,
        expires_at         INTEGER NOT NULL
      )
    `,
    `
      CREATE INDEX inference_cancellations_expiry_idx
      ON inference_cancellations(expires_at)
    `,
  ],
};
