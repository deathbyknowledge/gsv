import type { SqlMigration } from "../../schema/runner";

/**
 * Track only AppRunner objects that successfully crossed Kernel authority and
 * persist user lifecycle fence intent across target/Master restarts.
 */
export const KERNEL_V022_REGISTER_APP_RUNTIMES: SqlMigration = {
  id: 22,
  name: "register_app_runtimes",
  statements: [
    `
      CREATE TABLE app_runtime_runners (
        runner_name          TEXT PRIMARY KEY,
        owner_uid            INTEGER NOT NULL CHECK (owner_uid >= 0),
        owner_username       TEXT NOT NULL CHECK (length(owner_username) BETWEEN 1 AND 32),
        kernel_owner_uid     INTEGER NOT NULL CHECK (kernel_owner_uid >= 0),
        kernel_owner_username TEXT NOT NULL CHECK (
          length(kernel_owner_username) BETWEEN 1 AND 32
        ),
        package_id           TEXT NOT NULL,
        first_seen_at        INTEGER NOT NULL CHECK (first_seen_at > 0),
        last_seen_at         INTEGER NOT NULL CHECK (last_seen_at >= first_seen_at)
      )
    `,
    `
      CREATE INDEX app_runtime_runners_kernel_owner
      ON app_runtime_runners (
        kernel_owner_uid, kernel_owner_username, owner_uid, runner_name
      )
    `,
    `
      CREATE TABLE app_runtime_lifecycle_fences (
        owner_uid          INTEGER PRIMARY KEY CHECK (owner_uid >= 0),
        owner_username     TEXT NOT NULL UNIQUE,
        source_kernel_name TEXT NOT NULL,
        generation         INTEGER NOT NULL CHECK (generation > 0),
        fence_id           TEXT NOT NULL UNIQUE,
        target_lifecycle   TEXT NOT NULL CHECK (
          target_lifecycle IN ('provisioning', 'suspended', 'retired')
        ),
        created_at         INTEGER NOT NULL CHECK (created_at > 0)
      )
    `,
  ],
};
