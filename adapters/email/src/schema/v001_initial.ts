import type { MailSqlMigration } from "./migrations";

export const MAIL_V001_INITIAL_SCHEMA: MailSqlMigration = {
  id: 1,
  name: "initial_mail_transport_schema",
  statements: [
    `
      CREATE TABLE IF NOT EXISTS mail_installation_identity (
        singleton       INTEGER PRIMARY KEY CHECK (singleton = 1),
        installation_id TEXT    NOT NULL UNIQUE,
        created_at      INTEGER NOT NULL
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS mail_daily_usage (
        day                    TEXT    PRIMARY KEY,
        inbound_messages       INTEGER NOT NULL DEFAULT 0 CHECK (inbound_messages >= 0),
        inbound_bytes          INTEGER NOT NULL DEFAULT 0 CHECK (inbound_bytes >= 0),
        summarization_attempts INTEGER NOT NULL DEFAULT 0 CHECK (summarization_attempts >= 0)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS mail_intakes (
        intake_id                     TEXT    PRIMARY KEY,
        digest                        TEXT    NOT NULL UNIQUE,
        received_at                   INTEGER NOT NULL,
        raw_size                      INTEGER NOT NULL CHECK (raw_size >= 0),
        storage_state                 TEXT    NOT NULL CHECK (storage_state IN ('pending', 'stored')),
        summary_state                 TEXT    NOT NULL CHECK (summary_state IN (
          'pending', 'running', 'notifying', 'deferred', 'complete'
        )),
        raw_message                   BLOB,
        metadata_json                 TEXT,
        summary_input_json            TEXT,
        summary_json                  TEXT,
        message_id                    TEXT,
        storage_attempts              INTEGER NOT NULL DEFAULT 0 CHECK (storage_attempts >= 0),
        summary_attempts              INTEGER NOT NULL DEFAULT 0 CHECK (summary_attempts >= 0),
        completion_attempts           INTEGER NOT NULL DEFAULT 0 CHECK (completion_attempts >= 0),
        storage_next_attempt_at       INTEGER,
        summary_next_attempt_at       INTEGER,
        summary_reservation_expires_at INTEGER,
        stored_at                     INTEGER,
        completed_at                  INTEGER,
        updated_at                    INTEGER NOT NULL,
        CHECK (
          (storage_state = 'pending' AND raw_message IS NOT NULL AND metadata_json IS NOT NULL)
          OR
          (storage_state = 'stored' AND raw_message IS NULL AND metadata_json IS NULL
            AND message_id IS NOT NULL AND stored_at IS NOT NULL)
        )
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS mail_intakes_storage_retry_idx
      ON mail_intakes(storage_state, storage_next_attempt_at, received_at)
    `,
    `
      CREATE INDEX IF NOT EXISTS mail_intakes_summary_retry_idx
      ON mail_intakes(summary_state, summary_next_attempt_at, received_at)
    `,
    `
      CREATE INDEX IF NOT EXISTS mail_intakes_received_idx
      ON mail_intakes(received_at DESC, intake_id DESC)
    `,
  ],
};
