import type { SqlMigration } from "../../schema/runner";

/** One log of Kernel events and one delivery row per event and consumer. */
export const KERNEL_V092_EVENTS: SqlMigration = {
  id: 92,
  name: "events",
  statements: [
    `
      CREATE TABLE events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        owner_uid INTEGER NOT NULL,
        subject TEXT NOT NULL,
        actor_json TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        body_json TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE (type, idempotency_key)
      )
    `,
    "CREATE INDEX events_created ON events (created_at)",
    `
      CREATE TABLE deliveries (
        seq INTEGER NOT NULL REFERENCES events (seq) ON DELETE CASCADE,
        consumer TEXT NOT NULL,
        lane TEXT,
        state TEXT NOT NULL CHECK (state IN ('pending', 'delivered', 'withdrawn', 'failed')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        last_error TEXT,
        run_id TEXT,
        outcome_json TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (seq, consumer)
      )
    `,
    "CREATE INDEX deliveries_due ON deliveries (next_attempt_at) WHERE state = 'pending'",
    "CREATE INDEX deliveries_lane ON deliveries (consumer, lane, seq) WHERE state = 'pending' AND lane IS NOT NULL",
    // The staged approval notices returned at once; their task kind is gone.
    "DELETE FROM cf_agents_schedules WHERE callback = 'onProcessApprovalNotice'",
  ],
};
