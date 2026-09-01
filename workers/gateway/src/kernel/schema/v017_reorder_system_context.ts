import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V017_REORDER_SYSTEM_CONTEXT: SqlMigration = {
  id: 17,
  name: "reorder_system_context",
  statements: [
    `
      INSERT OR IGNORE INTO config_kv (key, value)
      SELECT 'config/ai/context.d/00-runtime.md', value
      FROM config_kv
      WHERE key = 'config/ai/context.d/10-runtime.md'
    `,
    `
      DELETE FROM config_kv
      WHERE key = 'config/ai/context.d/10-runtime.md'
    `,
    `
      INSERT OR IGNORE INTO config_kv (key, value)
      SELECT 'config/ai/context.d/01-gsv.md', value
      FROM config_kv
      WHERE key = 'config/ai/context.d/00-gsv.md'
    `,
    `
      DELETE FROM config_kv
      WHERE key = 'config/ai/context.d/00-gsv.md'
    `,
  ],
};
