import type { SqlMigration } from "../../schema/runner";

/**
 * Protocol 4: target syscalls replace device syscalls, and a token's kind is the
 * principal kind it authenticates as, bound to one peer id for machines.
 */
export const KERNEL_V037_CUT_OVER_TO_PROTOCOL_4: SqlMigration = {
  id: 37,
  name: "cut_over_to_protocol_4",
  statements: [
    `
      UPDATE OR IGNORE group_capabilities
      SET capability = 'sys.target.' || substr(capability, 12)
      WHERE capability LIKE 'sys.device.%'
    `,
    `
      DELETE FROM group_capabilities WHERE capability LIKE 'sys.device.%'
    `,
    `
      UPDATE auth_tokens SET kind = 'machine' WHERE kind = 'node'
    `,
    `
      UPDATE auth_tokens SET kind = 'human' WHERE kind = 'user'
    `,
    `
      ALTER TABLE auth_tokens RENAME COLUMN allowed_device_id TO peer_id
    `,
    `
      ALTER TABLE auth_tokens DROP COLUMN allowed_role
    `,
  ],
};
