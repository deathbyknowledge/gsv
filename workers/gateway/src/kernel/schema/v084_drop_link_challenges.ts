import type { SqlMigration } from "../../schema/runner";

/**
 * Messenger adapters pair people themselves, so the Kernel no longer issues
 * link codes or links identities by hand.
 */
export const KERNEL_V084_DROP_LINK_CHALLENGES: SqlMigration = {
  id: 84,
  name: "drop_link_challenges",
  statements: [
    "DROP TABLE link_challenges",
    "DELETE FROM group_capabilities WHERE capability IN ('sys.link', 'sys.unlink', 'sys.link.consume')",
  ],
};
