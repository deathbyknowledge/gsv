import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V070_PRESERVE_SYSTEM_CONTEXT_OVERRIDES: SqlMigration = {
  id: 70,
  name: "preserve_system_context_overrides",
  statements: [
    `
      INSERT OR IGNORE INTO config_kv (key, value)
      SELECT 'config/ai/context.d/02-interaction.md', ''
      FROM config_kv
      WHERE key = 'config/ai/context.d/01-gsv.md'
    `,
  ],
};
