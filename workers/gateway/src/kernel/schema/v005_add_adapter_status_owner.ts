import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V005_ADD_ADAPTER_STATUS_OWNER: SqlMigration = {
  id: 5,
  name: "add_adapter_status_owner",
  statements: [
    `
      ALTER TABLE adapter_status ADD COLUMN owner_uid INTEGER
    `,
    `
      DELETE FROM adapter_status AS candidate
      WHERE EXISTS (
        SELECT 1
        FROM adapter_status AS winner
        WHERE LOWER(TRIM(winner.adapter)) = LOWER(TRIM(candidate.adapter))
          AND winner.account_id = candidate.account_id
          AND (
            winner.updated_at > candidate.updated_at
            OR (winner.updated_at = candidate.updated_at AND winner.rowid > candidate.rowid)
          )
      )
    `,
    `
      UPDATE adapter_status
      SET adapter = LOWER(TRIM(adapter))
    `,
    `
      UPDATE adapter_status
      SET owner_uid = COALESCE(
        (
          SELECT CASE WHEN COUNT(DISTINCT identity_links.uid) = 1
            THEN MIN(identity_links.uid)
          END
          FROM identity_links
          WHERE identity_links.adapter = adapter_status.adapter
            AND identity_links.account_id = adapter_status.account_id
        ),
        0
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_adapter_status_owner
      ON adapter_status(owner_uid, adapter, account_id)
    `,
  ],
};
