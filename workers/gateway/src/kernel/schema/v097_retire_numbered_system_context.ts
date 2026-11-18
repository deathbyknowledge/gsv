import type { SqlMigration } from "../../schema/runner";

// System context moved from eight numbered files into config/ai/context.d/environment.md.
// A saved value under an old name would otherwise keep loading beside it.
const RETIRED_NAMES = [
  "00-runtime.md",
  "01-gsv.md",
  "02-interaction.md",
  "05-targets.md",
  "10-responsibilities.md",
  "15-memory.md",
  "20-discovery.md",
  "30-process-orchestration.md",
];

export const KERNEL_V097_RETIRE_NUMBERED_SYSTEM_CONTEXT: SqlMigration = {
  id: 97,
  name: "retire_numbered_system_context",
  statements: [
    `DELETE FROM config_kv WHERE key IN (${RETIRED_NAMES.map((name) => `'config/ai/context.d/${name}'`).join(", ")})`,
  ],
};
