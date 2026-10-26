import type { SqlMigration } from "../../schema/runner";

/**
 * The profile as Bluesky shows it: the `app.bsky.actor.profile` record the
 * Ship's repository holds beside the published `space.ship.profile` record,
 * or none. A profile published before Ships kept one has none until its
 * owner's next sign-in writes it.
 */
export const KERNEL_V080_PROFILE_MIRRORS: SqlMigration = {
  id: 80,
  name: "profile_mirrors",
  statements: [
    "ALTER TABLE social_profiles ADD COLUMN mirror_json TEXT CHECK (mirror_json IS NULL OR published_cid IS NOT NULL)",
  ],
};
