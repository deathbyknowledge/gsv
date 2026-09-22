import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V057_CONTACT_PREFERENCES_AND_BLOCKS: SqlMigration = {
  id: 57,
  name: "contact_preferences_and_blocks",
  statements: [
    "ALTER TABLE federation_contacts ADD COLUMN saved INTEGER NOT NULL DEFAULT 1 CHECK (saved IN (0, 1))",
    "ALTER TABLE federation_contacts ADD COLUMN muted INTEGER NOT NULL DEFAULT 0 CHECK (muted IN (0, 1))",
    "ALTER TABLE federation_contacts ADD COLUMN notification_policy TEXT NOT NULL DEFAULT 'notify' CHECK (notification_policy IN ('notify', 'digest', 'quiet'))",
    "ALTER TABLE federation_contacts ADD COLUMN policy_revision INTEGER NOT NULL DEFAULT 1",
    `CREATE TABLE federation_actor_blocks (
      owner_uid INTEGER NOT NULL,
      ship_id TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (owner_uid, ship_id, subject_id)
    )`,
  ],
};
