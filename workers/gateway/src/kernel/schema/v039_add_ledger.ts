import type { SqlMigration } from "../../schema/runner";

/**
 * The ledger: one row per dispatched syscall, kept in a small active window and
 * rotated into immutable R2 segments. `ledger_segments` is the index of what
 * has been rotated; the objects themselves live under `ledger/` in the
 * installation's storage.
 */
export const KERNEL_V039_ADD_LEDGER: SqlMigration = {
  id: 39,
  name: "add_ledger",
  statements: [
    `
      CREATE TABLE IF NOT EXISTS ledger_window (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        principal_kind TEXT NOT NULL,
        uid INTEGER NOT NULL,
        owner_uid INTEGER NOT NULL,
        pid TEXT,
        run_id TEXT,
        target TEXT NOT NULL,
        call TEXT NOT NULL,
        detail TEXT NOT NULL,
        outcome TEXT CHECK(outcome IN ('ok', 'failed', 'denied', 'cancelled')),
        duration_ms INTEGER,
        tokens INTEGER,
        cost_nano_usd INTEGER
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS ledger_window_request_idx
      ON ledger_window (request_id)
    `,
    `
      CREATE INDEX IF NOT EXISTS ledger_window_ts_idx
      ON ledger_window (ts)
    `,
    `
      CREATE TABLE IF NOT EXISTS ledger_segments (
        seq INTEGER PRIMARY KEY NOT NULL,
        first_seq INTEGER NOT NULL,
        object_key TEXT NOT NULL,
        first_ts INTEGER NOT NULL,
        last_ts INTEGER NOT NULL,
        row_count INTEGER NOT NULL,
        bytes INTEGER NOT NULL,
        uids TEXT,
        pids TEXT,
        targets TEXT,
        created_at INTEGER NOT NULL
      )
    `,
  ],
};
