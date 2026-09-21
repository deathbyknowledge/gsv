import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V063_PROFILE_IMAGES: SqlMigration = {
  id: 63,
  name: "profile_images",
  statements: [
    "ALTER TABLE social_profiles ADD COLUMN published_avatar_sha256 TEXT",
    `CREATE TABLE social_profile_images (
      owner_uid INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      reservation TEXT NOT NULL,
      object_key TEXT NOT NULL UNIQUE,
      avatar_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('writing', 'ready', 'retiring')),
      created_at INTEGER NOT NULL,
      PRIMARY KEY (owner_uid, sha256)
    )`,
    "CREATE INDEX social_profile_images_cleanup ON social_profile_images (owner_uid, state, created_at)",
  ],
};
