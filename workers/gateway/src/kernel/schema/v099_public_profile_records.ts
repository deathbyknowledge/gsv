import type { SqlMigration } from "../../schema/runner";

/**
 * A profile is always public, so it is the record the Ship's repository holds: every change
 * publishes at once and nothing waits as a draft. A published profile keeps its record, as it
 * is published; one never published, or unpublished since, is dropped with any draft it had,
 * and the Ship publishes its starting profile at its owner's next use. Pictures no record
 * shows go, and so does setup's choice to publish at the first sign-in.
 */
export const KERNEL_V099_PUBLIC_PROFILE_RECORDS: SqlMigration = {
  id: 99,
  name: "public_profile_records",
  statements: [
    `CREATE TABLE social_profiles_v099 (
      owner_uid INTEGER PRIMARY KEY,
      revision INTEGER NOT NULL,
      record_json TEXT NOT NULL,
      record_cid TEXT,
      mirror_json TEXT CHECK (mirror_json IS NULL OR record_cid IS NOT NULL)
    )`,
    `INSERT INTO social_profiles_v099 (owner_uid, revision, record_json, record_cid, mirror_json)
      SELECT owner_uid, revision, published_json, published_cid, mirror_json
      FROM social_profiles WHERE published_json IS NOT NULL`,
    "DROP TABLE social_profiles",
    "ALTER TABLE social_profiles_v099 RENAME TO social_profiles",
    `DELETE FROM social_profile_avatars WHERE cid NOT IN (
      SELECT json_extract(record_json, '$.avatar.ref."$link"') FROM social_profiles
        WHERE json_extract(record_json, '$.avatar.ref."$link"') IS NOT NULL
    )`,
    "DELETE FROM config_kv WHERE key LIKE 'users/%/profile/publish_chosen'",
  ],
};
