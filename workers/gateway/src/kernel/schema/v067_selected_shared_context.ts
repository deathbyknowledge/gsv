import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V067_SELECTED_SHARED_CONTEXT: SqlMigration = {
  id: 67, name: "selected_shared_context",
  statements: [
    "CREATE TABLE social_context_owners (owner_uid INTEGER PRIMARY KEY, sequence INTEGER NOT NULL DEFAULT 0)",
    `CREATE TABLE social_context_publications (
      owner_uid INTEGER NOT NULL, id TEXT NOT NULL, sequence INTEGER NOT NULL, revision INTEGER NOT NULL,
      kind TEXT NOT NULL, state TEXT NOT NULL, record_json TEXT NOT NULL, expires_at INTEGER NOT NULL,
      intent_id TEXT NOT NULL, intent_hash TEXT NOT NULL, delivery_id TEXT,
      subject_contact_id TEXT, subject_generation TEXT, retired_at INTEGER,
      PRIMARY KEY (owner_uid, id)
    )`,
    "CREATE INDEX social_context_publications_sequence ON social_context_publications (owner_uid, sequence)",
    "CREATE INDEX social_context_publications_subject ON social_context_publications (subject_contact_id, subject_generation)",
    `CREATE TABLE social_context_consents (
      owner_uid INTEGER NOT NULL, contact_id TEXT NOT NULL, generation TEXT NOT NULL, assertion_id TEXT NOT NULL,
      revision INTEGER NOT NULL, record_json TEXT, consent_json TEXT, delivery_id TEXT, expires_at INTEGER NOT NULL,
      PRIMARY KEY (contact_id, assertion_id)
    )`,
    "CREATE INDEX social_context_consents_owner ON social_context_consents (owner_uid, expires_at)",
    `CREATE TABLE social_context_receipts (
      owner_uid INTEGER NOT NULL, assertion_id TEXT NOT NULL, contact_id TEXT NOT NULL, generation TEXT NOT NULL,
      revision INTEGER NOT NULL, lease_until INTEGER NOT NULL, withdraw_through INTEGER NOT NULL DEFAULT 0, consent_proposal INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (owner_uid, assertion_id, contact_id, generation)
    )`,
    "CREATE INDEX social_context_receipts_withdrawal ON social_context_receipts (withdraw_through, lease_until)",
    `CREATE TABLE social_context_sources (
      contact_id TEXT PRIMARY KEY, owner_uid INTEGER NOT NULL, generation TEXT NOT NULL, revision INTEGER NOT NULL,
      kinds_json TEXT NOT NULL, sync_epoch INTEGER NOT NULL DEFAULT 1, projection_id TEXT, run_id TEXT,
      cursor TEXT, next_cursor TEXT, state TEXT NOT NULL, next_due INTEGER NOT NULL, updated_at INTEGER,
      run_started INTEGER
    )`,
    "CREATE INDEX social_context_sources_owner ON social_context_sources (owner_uid, contact_id)",
    "CREATE INDEX social_context_sources_due ON social_context_sources (next_due)",
    `CREATE TABLE social_context_cache (
      contact_id TEXT NOT NULL, projection_id TEXT NOT NULL, assertion_id TEXT NOT NULL, owner_uid INTEGER NOT NULL,
      subject_ship TEXT NOT NULL, subject_id TEXT NOT NULL, kind TEXT NOT NULL, revision INTEGER NOT NULL,
      lease_until INTEGER NOT NULL, received_at INTEGER NOT NULL, record_json TEXT NOT NULL,
      PRIMARY KEY (contact_id, projection_id, assertion_id)
    )`,
    "CREATE INDEX social_context_cache_subject ON social_context_cache (owner_uid, subject_ship, subject_id, contact_id, assertion_id)",
  ],
};
