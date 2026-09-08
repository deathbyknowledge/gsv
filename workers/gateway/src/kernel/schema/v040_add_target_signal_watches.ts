import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V040_ADD_TARGET_SIGNAL_WATCHES: SqlMigration = {
  id: 40,
  name: "add_target_signal_watches",
  statements: [
    "ALTER TABLE signal_watches ADD COLUMN source_target_id TEXT",
    "ALTER TABLE signal_watches ADD COLUMN event_audience TEXT",
    "ALTER TABLE signal_watches ADD COLUMN revision INTEGER NOT NULL DEFAULT 1",
    "CREATE INDEX signal_watches_source_target_idx ON signal_watches (source_target_id, signal, status, expires_at)",
  ],
};
