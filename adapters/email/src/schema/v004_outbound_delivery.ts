import type { MailSqlMigration } from "./migrations";

export const MAIL_V004_OUTBOUND_DELIVERY: MailSqlMigration = {
  id: 4,
  name: "managed_mail_outbound_delivery",
  statements: [
    `
      ALTER TABLE mail_daily_usage
      ADD COLUMN outbound_messages INTEGER NOT NULL DEFAULT 0
        CHECK (outbound_messages >= 0)
    `,
    `
      ALTER TABLE mail_daily_usage
      ADD COLUMN outbound_bytes INTEGER NOT NULL DEFAULT 0
        CHECK (outbound_bytes >= 0)
    `,
    `
      CREATE TABLE IF NOT EXISTS mail_outbound_deliveries (
        outbound_id                 TEXT    NOT NULL,
        fingerprint                 TEXT    NOT NULL,
        expected_from               TEXT,
        state                       TEXT    NOT NULL CHECK (state IN (
          'claiming', 'attempting', 'accepted', 'failed', 'unknown'
        )),
        text_size                   INTEGER CHECK (text_size >= 0),
        usage_day                   TEXT,
        provider_message_id         TEXT,
        error_code                  TEXT,
        claim_attempts              INTEGER NOT NULL DEFAULT 0
          CHECK (claim_attempts >= 0),
        claim_next_attempt_at        INTEGER,
        attempting_expires_at       INTEGER,
        callback_attempts           INTEGER NOT NULL DEFAULT 0
          CHECK (callback_attempts >= 0),
        callback_next_attempt_at     INTEGER,
        callback_completed_at        INTEGER,
        created_at                  INTEGER NOT NULL,
        updated_at                  INTEGER NOT NULL,
        PRIMARY KEY (outbound_id, fingerprint),
        CHECK (
          (state = 'claiming'
            AND claim_next_attempt_at IS NOT NULL
            AND attempting_expires_at IS NULL
            AND callback_next_attempt_at IS NULL
            AND callback_completed_at IS NULL)
          OR
          (state = 'attempting'
            AND claim_next_attempt_at IS NULL
            AND attempting_expires_at IS NOT NULL
            AND callback_next_attempt_at IS NULL
            AND callback_completed_at IS NULL)
          OR
          (state IN ('accepted', 'failed', 'unknown')
            AND claim_next_attempt_at IS NULL
            AND attempting_expires_at IS NULL
            AND (
              callback_next_attempt_at IS NOT NULL
              OR callback_completed_at IS NOT NULL
            ))
        )
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS mail_outbound_id_idx
      ON mail_outbound_deliveries(outbound_id)
    `,
    `
      CREATE INDEX IF NOT EXISTS mail_outbound_claim_idx
      ON mail_outbound_deliveries(claim_next_attempt_at, created_at)
      WHERE state = 'claiming'
    `,
    `
      CREATE INDEX IF NOT EXISTS mail_outbound_callback_idx
      ON mail_outbound_deliveries(callback_next_attempt_at, created_at)
      WHERE callback_completed_at IS NULL
    `,
    `
      CREATE INDEX IF NOT EXISTS mail_outbound_attempting_idx
      ON mail_outbound_deliveries(attempting_expires_at)
      WHERE state = 'attempting'
    `,
  ],
};
