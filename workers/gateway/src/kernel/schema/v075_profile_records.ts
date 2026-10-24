import type { SqlMigration } from "../../schema/runner";

/**
 * A profile is published as the Ship's `space.ship.profile` record instead of a
 * signed document. A signed profile becomes the record it carries, without a CID
 * until the Kernel writes it to the Ship's repository at its owner's next sign-in.
 */
export const KERNEL_V075_PROFILE_RECORDS: SqlMigration = {
  id: 75,
  name: "profile_records",
  statements: [
    `CREATE TABLE social_profile_avatars (
      cid TEXT PRIMARY KEY,
      mime_type TEXT NOT NULL,
      bytes BLOB NOT NULL
    )`,
    `CREATE TABLE social_profiles_v075 (
      owner_uid INTEGER PRIMARY KEY,
      revision INTEGER NOT NULL,
      draft_json TEXT NOT NULL,
      draft_avatar_cid TEXT,
      published_revision INTEGER,
      published_json TEXT,
      published_cid TEXT,
      CHECK ((published_json IS NULL) = (published_revision IS NULL)),
      CHECK (published_cid IS NULL OR published_json IS NOT NULL)
    )`,
    `INSERT INTO social_profiles_v075 (owner_uid, revision, draft_json, published_revision, published_json)
      SELECT owner_uid, revision, json_remove(draft_json, '$.representation'),
        CASE WHEN published_json IS NULL THEN NULL ELSE published_revision END,
        CASE
          WHEN published_json IS NULL OR published_revision IS NULL THEN NULL
          WHEN COALESCE(json_extract(published_json, '$.about'), '') = '' THEN json_object(
            '$type', 'space.ship.profile',
            'displayName', json_extract(published_json, '$.displayName'),
            'contactPolicy', json_extract(published_json, '$.contactPolicy'))
          ELSE json_object(
            '$type', 'space.ship.profile',
            'displayName', json_extract(published_json, '$.displayName'),
            'about', json_extract(published_json, '$.about'),
            'contactPolicy', json_extract(published_json, '$.contactPolicy'))
        END
      FROM social_profiles`,
    "DROP TABLE social_profiles",
    "ALTER TABLE social_profiles_v075 RENAME TO social_profiles",
  ],
};
