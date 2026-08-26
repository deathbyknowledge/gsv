import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V020_ADD_MAILBOXES: SqlMigration = {
  id: 20,
  name: "add_mailboxes",
  statements: [
    `
      CREATE TABLE IF NOT EXISTS mailboxes (
        mailbox_id       TEXT    PRIMARY KEY,
        owner_uid        INTEGER NOT NULL,
        address          TEXT    NOT NULL UNIQUE,
        notification_pid TEXT,
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_mailboxes_owner
      ON mailboxes(owner_uid, created_at)
    `,
    `
      CREATE TABLE IF NOT EXISTS mail_messages (
        message_id          TEXT    PRIMARY KEY,
        mailbox_id          TEXT    NOT NULL,
        digest              TEXT    NOT NULL,
        envelope_from       TEXT    NOT NULL,
        envelope_to         TEXT    NOT NULL,
        header_message_id   TEXT,
        display_from        TEXT,
        to_json             TEXT    NOT NULL,
        cc_json             TEXT    NOT NULL,
        reply_to_json       TEXT    NOT NULL,
        subject             TEXT,
        sent_at             INTEGER,
        received_at         INTEGER NOT NULL,
        raw_path            TEXT    NOT NULL,
        text_path           TEXT    NOT NULL,
        size_bytes          INTEGER NOT NULL,
        attachments_json    TEXT    NOT NULL,
        summary             TEXT,
        category            TEXT,
        requires_attention  INTEGER,
        confidence          REAL,
        summarized_at       INTEGER,
        event_delivered_at  INTEGER,
        created_at          INTEGER NOT NULL,
        UNIQUE(mailbox_id, digest)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS mail_intakes (
        intake_id   TEXT    PRIMARY KEY,
        mailbox_id  TEXT    NOT NULL,
        message_id  TEXT    NOT NULL,
        digest      TEXT    NOT NULL,
        received_at INTEGER NOT NULL,
        created_at  INTEGER NOT NULL
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_mail_messages_mailbox_received
      ON mail_messages(mailbox_id, received_at DESC, message_id DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_mail_intakes_message
      ON mail_intakes(message_id, created_at)
    `,
  ],
};
