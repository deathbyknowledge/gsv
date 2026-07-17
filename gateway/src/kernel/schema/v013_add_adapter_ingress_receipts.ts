import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V013_ADD_ADAPTER_INGRESS_RECEIPTS: SqlMigration = {
  id: 13,
  name: "add_adapter_ingress_receipts",
  statements: [
    `
      CREATE TABLE IF NOT EXISTS adapter_ingress_receipts (
        receipt_id          TEXT    NOT NULL UNIQUE,
        adapter             TEXT    NOT NULL,
        account_id          TEXT    NOT NULL,
        actor_id            TEXT    NOT NULL,
        surface_kind        TEXT    NOT NULL,
        surface_id          TEXT    NOT NULL,
        thread_id           TEXT    NOT NULL DEFAULT '',
        provider_message_id TEXT    NOT NULL,
        state               TEXT    NOT NULL CHECK (state IN ('in_progress', 'completed')),
        result_json         TEXT,
        created_at          INTEGER NOT NULL,
        completed_at        INTEGER,
        PRIMARY KEY (
          adapter,
          account_id,
          actor_id,
          surface_kind,
          surface_id,
          thread_id,
          provider_message_id
        )
      )
    `,
  ],
};
