import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V022_ADD_OUTBOUND_MAIL: SqlMigration = {
  id: 22,
  name: "add_outbound_mail",
  statements: [
    `
      CREATE TABLE IF NOT EXISTS mail_outbound (
        outbound_id          TEXT    PRIMARY KEY,
        owner_uid            INTEGER NOT NULL,
        delivery_id          TEXT    NOT NULL,
        fingerprint          TEXT    NOT NULL,
        from_address         TEXT    NOT NULL,
        to_address           TEXT    NOT NULL,
        subject              TEXT    NOT NULL,
        body_digest          TEXT    NOT NULL,
        body_path            TEXT    NOT NULL,
        text_size            INTEGER NOT NULL CHECK (text_size > 0),
        reply_to_message_id  TEXT,
        in_reply_to_header   TEXT,
        references_header    TEXT,
        state                TEXT    NOT NULL CHECK (state IN (
          'staging', 'queued', 'accepted', 'failed', 'unknown'
        )),
        provider_message_id  TEXT,
        error_code           TEXT,
        enqueue_attempts     INTEGER NOT NULL DEFAULT 0 CHECK (enqueue_attempts >= 0),
        enqueue_next_at      INTEGER,
        enqueued_at          INTEGER,
        created_at           INTEGER NOT NULL,
        queued_at            INTEGER,
        completed_at         INTEGER,
        UNIQUE(owner_uid, delivery_id),
        CHECK (
          (state = 'staging' AND queued_at IS NULL AND completed_at IS NULL)
          OR
          (state = 'queued' AND queued_at IS NOT NULL AND completed_at IS NULL)
          OR
          (state IN ('accepted', 'failed', 'unknown')
            AND queued_at IS NOT NULL AND completed_at IS NOT NULL)
        ),
        CHECK (
          (state = 'accepted' AND provider_message_id IS NOT NULL AND error_code IS NULL)
          OR
          (state IN ('failed', 'unknown') AND provider_message_id IS NULL AND error_code IS NOT NULL)
          OR
          (state IN ('staging', 'queued') AND provider_message_id IS NULL AND error_code IS NULL)
        ),
        CHECK (enqueued_at IS NULL OR queued_at IS NOT NULL),
        CHECK (state = 'queued' OR enqueue_next_at IS NULL)
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_mail_outbound_owner_created
      ON mail_outbound(owner_uid, created_at DESC, outbound_id DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_mail_outbound_enqueue
      ON mail_outbound(enqueue_next_at, created_at)
      WHERE state = 'queued' AND enqueued_at IS NULL
    `,
  ],
};
