import type { SqlMigration } from "../../schema/runner";

const RULE_TARGET = "json_extract(rule.value, '$.target')";
const LEGACY_WHEN_TARGET = "json_extract(rule.value, '$.when.target')";

function anyTarget(value: string): string {
  return `(coalesce(trim(${value}), '') IN ('', '*') OR lower(trim(${value})) = 'any')`;
}

function gsvTarget(value: string): string {
  return `(trim(${value}) = 'gsv' OR lower(trim(${value})) IN ('gateway', 'local'))`;
}

/** Whether a stored rule applies to `gsv`, read as `parseRule` reads it; it drops an unreadable target or action. */
const RULE_COVERS_GSV = `
  CASE
    WHEN json_type(rule.value, '$.action') IS NOT 'text'
      OR json_extract(rule.value, '$.action') NOT IN ('auto', 'ask', 'deny') THEN 0
    WHEN json_type(rule.value, '$.target') = 'object' THEN 0
    WHEN json_type(rule.value, '$.target') <> 'text' THEN 0
    WHEN NOT ${anyTarget(RULE_TARGET)} THEN ${gsvTarget(RULE_TARGET)}
    WHEN json_type(rule.value, '$.when.target') = 'text' AND NOT ${anyTarget(LEGACY_WHEN_TARGET)}
      THEN ${gsvTarget(LEGACY_WHEN_TARGET)}
    ELSE 1
  END`;

/** A saved policy gains the rule the default has: Ship asks before it starts acting on a source. */
const ASK_BEFORE_SHIP_ACTS = `
  UPDATE config_kv
  SET value = json_insert(value, '$.rules[#]', json('{"match":"event.source.update","action":"ask"}'))
  WHERE (key = 'config/ai/tools/approval' OR key LIKE 'users/%/ai/tools/approval')
    AND json_valid(value)
    AND json_type(value, '$.rules') = 'array'
    AND NOT EXISTS (
      SELECT 1 FROM json_each(config_kv.value, '$.rules') AS rule
      WHERE rule.type = 'object'
        AND json_type(rule.value, '$.match') = 'text'
        AND trim(json_extract(rule.value, '$.match')) IN ('event.source.update', 'event.source.*', 'event.*')
        AND ${RULE_COVERS_GSV}
    )
`;

/** Where an owner's custom events come from, what each one does, and what has arrived. */
export const KERNEL_V090_EVENT_SOURCES: SqlMigration = {
  id: 90,
  name: "event_sources",
  statements: [
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
    "CREATE INDEX event_log_owner_received ON event_log (owner_uid, received_at)",
    "CREATE INDEX event_log_source_received ON event_log (source_id, received_at)",
    "CREATE INDEX event_log_received ON event_log (received_at)",
    ASK_BEFORE_SHIP_ACTS,
  ],
};
