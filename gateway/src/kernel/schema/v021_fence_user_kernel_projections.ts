import type { SqlMigration } from "../../schema/runner";

/**
 * Persist the Master projection clock and each user Kernel's installed/fenced
 * projection state. The same schema exists in every Kernel DO; instance kind
 * determines which columns are authoritative.
 */
export const KERNEL_V021_FENCE_USER_KERNEL_PROJECTIONS: SqlMigration = {
  id: 21,
  name: "fence_user_kernel_projections",
  statements: [
    `
      CREATE TABLE kernel_projection_state (
        id                          INTEGER PRIMARY KEY CHECK (id = 1),
        master_revision             INTEGER NOT NULL CHECK (master_revision > 0),
        pending_master_revision     INTEGER CHECK (pending_master_revision IS NULL OR pending_master_revision > 0),
        installed_username          TEXT,
        installed_uid               INTEGER CHECK (installed_uid IS NULL OR installed_uid >= 0),
        installed_kernel_generation INTEGER CHECK (installed_kernel_generation IS NULL OR installed_kernel_generation > 0),
        installed_revision          INTEGER CHECK (installed_revision IS NULL OR installed_revision > 0),
        installed_digest            TEXT,
        package_fence_id            TEXT,
        package_fence_generation    INTEGER CHECK (package_fence_generation IS NULL OR package_fence_generation > 0),
        package_fence_started_at    INTEGER CHECK (package_fence_started_at IS NULL OR package_fence_started_at > 0)
      )
    `,
    `
      INSERT INTO kernel_projection_state (
        id, master_revision, pending_master_revision,
        installed_username, installed_uid, installed_kernel_generation,
        installed_revision, installed_digest, package_fence_id, package_fence_generation,
        package_fence_started_at
      ) VALUES (1, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)
    `,
  ],
};
