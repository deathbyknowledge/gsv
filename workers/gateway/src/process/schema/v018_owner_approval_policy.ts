import type { SqlMigration } from "../../schema/runner";

/**
 * Approval now follows the owner's policy. Per-process allows are dropped, and
 * a run already under way swaps its copied policy for one that asks, so its
 * first decision reads the owner's current policy before acting.
 */
export const PROCESS_V018_OWNER_APPROVAL_POLICY: SqlMigration = {
  id: 18,
  name: "owner_approval_policy",
  statements: [
    "DELETE FROM process_kv WHERE key = 'toolApprovalOverrides'",
    `UPDATE process_kv SET value = json_set(value, '$.approvalPolicy', json('{"default":"ask","rules":[]}'))
     WHERE key = 'currentRun' AND json_valid(value)`,
  ],
};
