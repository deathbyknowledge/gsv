import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V055_VERSION_FEDERATION_DELIVERY: SqlMigration = {
  id: 55,
  name: "version_federation_delivery",
  statements: [
    "ALTER TABLE federation_contacts ADD COLUMN protocol_version INTEGER NOT NULL DEFAULT 1 CHECK (protocol_version IN (1, 2))",
    "ALTER TABLE federation_contacts ADD COLUMN protocol_features_json TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE federation_contacts ADD COLUMN protocol_checked_at INTEGER",
    "ALTER TABLE federation_outbox ADD COLUMN wire_version INTEGER NOT NULL DEFAULT 1 CHECK (wire_version IN (1, 2))",
    "ALTER TABLE federation_inbox ADD COLUMN wire_version INTEGER NOT NULL DEFAULT 1 CHECK (wire_version IN (1, 2))",
  ],
};
