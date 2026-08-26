import type { MailSqlMigration } from "./migrations";

export const MAIL_V002_STAGED_INTAKE: MailSqlMigration = {
  id: 2,
  name: "staged_mail_intake",
  statements: [
    `
      CREATE TABLE IF NOT EXISTS mail_intake_uploads (
        intake_id         TEXT    PRIMARY KEY,
        digest            TEXT    NOT NULL UNIQUE,
        received_at       INTEGER NOT NULL,
        raw_size          INTEGER NOT NULL CHECK (raw_size > 0),
        metadata_json     TEXT    NOT NULL,
        summary_input_json TEXT   NOT NULL,
        usage_day         TEXT    NOT NULL,
        expires_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS mail_intake_uploads_expiry_idx
      ON mail_intake_uploads(expires_at)
    `,
  ],
};
