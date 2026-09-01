import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V004_REMOVE_LEGACY_SIGNAL_WATCHES: SqlMigration = {
  id: 4,
  name: "remove_legacy_signal_watches",
  statements: [
    `
      DELETE FROM signal_watches
      WHERE dedupe_key LIKE 'live:%'
         OR dedupe_key LIKE '__gsv_live__:%'
    `,
  ],
};
