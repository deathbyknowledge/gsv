import type { SqlMigration } from "../../schema/runner";

/**
 * Word search over received mail. A message's headers and the start of its
 * body are indexed when it arrives, and its summary when that completes.
 * Messages received before this index contribute headers and summary only,
 * since their bodies live in storage outside SQLite.
 */
export const KERNEL_V083_MAIL_SEARCH: SqlMigration = {
  id: 83,
  name: "mail_search",
  statements: [
    "ALTER TABLE mail_messages ADD COLUMN search_rowid INTEGER",
    "UPDATE mail_messages SET search_rowid = rowid",
    "CREATE UNIQUE INDEX mail_messages_search_rowid ON mail_messages (search_rowid)",
    "CREATE VIRTUAL TABLE mail_search USING fts5(text, content='', contentless_delete=1)",
    "CREATE VIRTUAL TABLE mail_summary_search USING fts5(text, content='', contentless_delete=1)",
    `
      INSERT INTO mail_search (rowid, text)
      SELECT search_rowid,
             COALESCE(subject, '') || ' ' || COALESCE(display_from, '') || ' ' || envelope_from || ' ' || to_json || ' ' || cc_json
        FROM mail_messages
    `,
    `
      INSERT INTO mail_summary_search (rowid, text)
      SELECT search_rowid, summary FROM mail_messages WHERE summary IS NOT NULL
    `,
  ],
};
