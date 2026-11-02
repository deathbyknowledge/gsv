import type { SqlMigration } from "../../schema/runner";

/** v090's two sender-named webhooks, as the hmac schemes that describe their signatures. */
const SENDER_SCHEMES = {
  github: JSON.stringify({ header: "x-hub-signature-256", encoding: "hex", prefix: "sha256=", idHeader: "x-github-delivery", typeHeader: "x-github-event" }),
  stripe: JSON.stringify({ header: "stripe-signature", encoding: "hex", pairs: { timestamp: "t", signature: "v1" } }),
};

const SOURCE_COLUMNS = `source_id, owner_uid, name, label, notify, ship, webhook, hmac_json, sender_secret, secret, previous_secret,
  previous_secret_until, enabled, expect_every_ms, last_event_at, silence_noted_at, bucket_tokens, bucket_at, created_by,
  changed_by, created_at, updated_at`;

const LOG_COLUMNS = "source_id, event_id, owner_uid, title, preview, body, emitted_by, received_at";

/**
 * A webhook names how its deliveries are signed, not who sends them. Both tables are rebuilt,
 * the log first, so dropping the old sources can't cascade into the events kept.
 */
export const KERNEL_V091_WEBHOOK_SIGNATURE_SCHEMES: SqlMigration = {
  id: 91,
  name: "webhook_signature_schemes",
  statements: [
    "ALTER TABLE event_log RENAME TO event_log_v090",
    "ALTER TABLE event_sources RENAME TO event_sources_v090",
    `
      CREATE TABLE event_sources (
        source_id TEXT PRIMARY KEY,
        owner_uid INTEGER NOT NULL,
        name TEXT NOT NULL,
        label TEXT NOT NULL,
        notify TEXT NOT NULL CHECK (notify IN ('none', 'messenger')),
        ship TEXT NOT NULL CHECK (ship IN ('none', 'context', 'wake')),
        webhook TEXT NOT NULL CHECK (webhook IN ('none', 'url', 'standard', 'hmac')),
        hmac_json TEXT CHECK ((webhook = 'hmac') = (hmac_json IS NOT NULL)),
        sender_secret INTEGER NOT NULL DEFAULT 0 CHECK (sender_secret IN (0, 1)),
        secret TEXT,
        previous_secret TEXT,
        previous_secret_until INTEGER,
        enabled INTEGER NOT NULL DEFAULT 1,
        expect_every_ms INTEGER,
        last_event_at INTEGER,
        silence_noted_at INTEGER,
        bucket_tokens REAL NOT NULL,
        bucket_at INTEGER NOT NULL,
        created_by TEXT NOT NULL CHECK (created_by IN ('person', 'ship')),
        changed_by TEXT CHECK (changed_by IN ('person', 'ship')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (owner_uid, name)
      )
    `,
    `
      INSERT INTO event_sources (${SOURCE_COLUMNS})
      SELECT source_id, owner_uid, name, label, notify, ship,
        CASE WHEN webhook IN ('github', 'stripe') THEN 'hmac' ELSE webhook END,
        CASE webhook WHEN 'github' THEN '${SENDER_SCHEMES.github}' WHEN 'stripe' THEN '${SENDER_SCHEMES.stripe}' END,
        CASE WHEN webhook = 'stripe' THEN 1 ELSE 0 END,
        secret, previous_secret, previous_secret_until, enabled, expect_every_ms, last_event_at, silence_noted_at,
        bucket_tokens, bucket_at, created_by, changed_by, created_at, updated_at
      FROM event_sources_v090
    `,
    `
      CREATE TABLE event_log (
        source_id TEXT NOT NULL REFERENCES event_sources (source_id) ON DELETE CASCADE,
        event_id TEXT NOT NULL,
        owner_uid INTEGER NOT NULL,
        title TEXT NOT NULL,
        preview TEXT,
        body TEXT,
        emitted_by TEXT NOT NULL CHECK (emitted_by IN ('client', 'process', 'schedule', 'webhook')),
        received_at INTEGER NOT NULL,
        PRIMARY KEY (source_id, event_id)
      )
    `,
    `INSERT INTO event_log (${LOG_COLUMNS}) SELECT ${LOG_COLUMNS} FROM event_log_v090`,
    "DROP TABLE event_log_v090",
    "DROP TABLE event_sources_v090",
    "CREATE INDEX event_log_owner_received ON event_log (owner_uid, received_at)",
    "CREATE INDEX event_log_source_received ON event_log (source_id, received_at)",
    "CREATE INDEX event_log_received ON event_log (received_at)",
  ],
};
