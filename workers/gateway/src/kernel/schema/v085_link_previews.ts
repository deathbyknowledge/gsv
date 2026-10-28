import type { SqlMigration } from "../../schema/runner";

/**
 * Cached page metadata for link previews, keyed by the requested URL. A
 * failed fetch keeps only its category, and a row's image key names the
 * installation-scoped object holding its image bytes. An image object whose
 * deletion failed after no row named it any more is remembered as an orphan
 * until a later pruning pass deletes it.
 */
export const KERNEL_V085_LINK_PREVIEWS: SqlMigration = {
  id: 85,
  name: "link_previews",
  statements: [
    `
      CREATE TABLE link_previews (
        url TEXT PRIMARY KEY,
        resolved_url TEXT,
        title TEXT,
        description TEXT,
        site_name TEXT,
        image_key TEXT,
        image_mime TEXT,
        image_size INTEGER,
        image_width INTEGER,
        image_height INTEGER,
        error TEXT CHECK (error IN ('unsupported', 'blocked', 'unreachable', 'too-large', 'timeout')),
        fetched_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        CHECK ((error IS NULL) = (resolved_url IS NOT NULL)),
        CHECK ((image_key IS NULL) = (image_mime IS NULL) AND (image_key IS NULL) = (image_size IS NULL))
      )
    `,
    "CREATE INDEX link_previews_expiry ON link_previews (expires_at)",
    "CREATE INDEX link_previews_image ON link_previews (image_key) WHERE image_key IS NOT NULL",
    `
      CREATE TABLE link_preview_orphans (
        image_key TEXT PRIMARY KEY,
        failed_at INTEGER NOT NULL
      )
    `,
  ],
};
