import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V023_ADD_MANAGED_ENTITLEMENT: SqlMigration = {
  id: 23,
  name: "add_managed_entitlement",
  statements: [
    `
      CREATE TABLE IF NOT EXISTS managed_entitlement (
        record_id                      INTEGER PRIMARY KEY CHECK (record_id = 1),
        installation_id                TEXT NOT NULL UNIQUE,
        state                          TEXT NOT NULL CHECK (
          state IN ('trialing', 'active', 'past_due', 'restricted', 'cancelled', 'retained')
        ),
        plan_key                       TEXT NOT NULL,
        inference_budget_microunits    INTEGER NOT NULL CHECK (inference_budget_microunits >= 0),
        inference_period_starts_at     INTEGER NOT NULL,
        inference_period_ends_at       INTEGER NOT NULL,
        storage_limit_bytes            INTEGER NOT NULL CHECK (storage_limit_bytes >= 0),
        effective_at                   INTEGER NOT NULL,
        version                        INTEGER NOT NULL CHECK (version >= 1),
        CHECK (inference_period_ends_at > inference_period_starts_at)
      )
    `,
  ],
};
