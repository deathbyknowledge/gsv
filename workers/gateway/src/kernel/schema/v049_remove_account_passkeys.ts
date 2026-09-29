import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V049_REMOVE_ACCOUNT_PASSKEYS: SqlMigration = {
  id: 49,
  name: "remove_account_passkeys",
  statements: [
    "DELETE FROM group_capabilities WHERE capability GLOB 'account.passkey.*'",
    "DROP TABLE account_passkey_challenges",
    "DROP TABLE account_passkeys",
    "DROP TABLE account_passkey_users",
  ],
};
