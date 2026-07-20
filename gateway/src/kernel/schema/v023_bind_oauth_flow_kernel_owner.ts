import type { SqlMigration } from "../../schema/runner";

/**
 * Bind newly-created OAuth callbacks to the human Kernel that admitted the
 * flow. Existing in-flight legacy states remain unbound and are rejected at
 * callback time rather than guessed from their run-as uid.
 */
export const KERNEL_V023_BIND_OAUTH_FLOW_KERNEL_OWNER: SqlMigration = {
  id: 23,
  name: "bind_oauth_flow_kernel_owner",
  statements: [
    `
      ALTER TABLE oauth_flows
      ADD COLUMN kernel_owner_uid INTEGER CHECK (
        kernel_owner_uid IS NULL OR kernel_owner_uid >= 0
      )
    `,
  ],
};
