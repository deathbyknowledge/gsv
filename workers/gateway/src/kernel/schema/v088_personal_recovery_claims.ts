import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V088_PERSONAL_RECOVERY_CLAIMS: SqlMigration = {
  id: 88,
  name: "personal_recovery_claims",
  statements: [
    "ALTER TABLE account_recovery_claims ADD COLUMN personal_uid INTEGER",
    "ALTER TABLE account_recovery_claims ADD COLUMN personal_credential_epoch INTEGER",
  ],
};
