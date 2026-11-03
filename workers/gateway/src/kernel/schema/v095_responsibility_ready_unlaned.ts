import type { SqlMigration } from "../../schema/runner";

/** A wake batch goes whenever it is due, so a stuck event in Ship's background lane never holds it. */
export const KERNEL_V095_RESPONSIBILITY_READY_UNLANED: SqlMigration = {
  id: 95,
  name: "responsibility_ready_unlaned",
  statements: [
    `
      UPDATE deliveries SET lane = NULL
      WHERE lane IS NOT NULL AND seq IN (SELECT seq FROM events WHERE type = 'responsibility.ready')
    `,
  ],
};
