import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V009_BIND_RUN_REPLY_ROUTES: SqlMigration = {
  id: 9,
  name: "bind_run_reply_routes",
  statements: [
    `
      ALTER TABLE run_routes ADD COLUMN process_id TEXT
    `,
    `
      ALTER TABLE run_routes ADD COLUMN actor_id TEXT
    `,
    // Existing routes cannot be authorized against a process and linked actor.
    // They are short-lived delivery state, so discard them at the hard cutover.
    `
      DELETE FROM run_routes
    `,
  ],
};
