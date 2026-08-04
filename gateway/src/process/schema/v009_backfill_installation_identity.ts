import type { SqlMigration } from "../../schema/runner";

export const PROCESS_V009_BACKFILL_INSTALLATION_IDENTITY: SqlMigration = {
  id: 9,
  name: "backfill_installation_identity",
  statements: [
    `
      INSERT OR IGNORE INTO process_kv (key, value)
      SELECT 'installationId', 'singleton'
      WHERE EXISTS (
        SELECT 1 FROM process_kv WHERE key = 'pid'
      )
    `,
  ],
};
