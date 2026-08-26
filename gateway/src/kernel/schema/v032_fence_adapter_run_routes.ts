import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V032_FENCE_ADAPTER_RUN_ROUTES: SqlMigration = {
  id: 32,
  name: "fence_adapter_run_routes",
  statements: [
    `
      ALTER TABLE run_routes ADD COLUMN route_generation TEXT
    `,
  ],
};
