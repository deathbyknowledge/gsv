import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V059_PUBLIC_PROFILES: SqlMigration = {
  id: 59,
  name: "public_profiles",
  statements: [
    `CREATE TABLE social_profiles (
      owner_uid INTEGER PRIMARY KEY,
      subject_id TEXT NOT NULL UNIQUE,
      revision INTEGER NOT NULL,
      draft_json TEXT NOT NULL,
      published_alias TEXT,
      published_revision INTEGER,
      published_json TEXT
    )`,
    `CREATE TABLE social_profile_aliases (
      alias TEXT PRIMARY KEY,
      owner_uid INTEGER NOT NULL
    )`,
    "CREATE UNIQUE INDEX social_profile_published_alias ON social_profiles (published_alias)",
    "CREATE INDEX social_profile_alias_owner ON social_profile_aliases (owner_uid)",
  ],
};
