import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V050_RETAIN_REVOKED_IDENTITY_LINKS: SqlMigration = {
  id: 50,
  name: "retain_revoked_identity_links",
  statements: ["ALTER TABLE identity_links ADD COLUMN revoked_at INTEGER"],
};
