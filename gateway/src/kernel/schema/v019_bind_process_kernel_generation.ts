import type { SqlMigration } from "../../schema/runner";

/**
 * Bind each new Process executor to the user-Kernel generation that created it.
 * Existing Master/legacy rows remain null; active user Kernels fail closed on
 * those rows and allocate fresh executors after reprovisioning.
 */
export const KERNEL_V019_BIND_PROCESS_KERNEL_GENERATION: SqlMigration = {
  id: 19,
  name: "bind_process_kernel_generation",
  statements: [
    `
      ALTER TABLE processes
      ADD COLUMN kernel_generation INTEGER
      CHECK (kernel_generation IS NULL OR kernel_generation > 0)
    `,
  ],
};
