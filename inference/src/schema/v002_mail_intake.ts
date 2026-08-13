import type { InferenceSqlMigration } from "./migrations";

export const INFERENCE_V002_MAIL_INTAKE: InferenceSqlMigration = {
  id: 2,
  name: "mail_intake_replay_results",
  statements: [
    `
      ALTER TABLE inference_requests
      ADD COLUMN purpose TEXT NOT NULL DEFAULT 'agent'
        CHECK (purpose IN ('agent', 'mail-intake'))
    `,
    `
      ALTER TABLE inference_requests
      ADD COLUMN request_fingerprint TEXT
    `,
    `
      ALTER TABLE inference_requests
      ADD COLUMN result_json TEXT
    `,
  ],
};
