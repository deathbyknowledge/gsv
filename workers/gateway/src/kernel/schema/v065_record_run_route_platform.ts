import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V065_RECORD_RUN_ROUTE_PLATFORM: SqlMigration = {
  id: 65,
  name: "record_run_route_platform",
  statements: [
    "ALTER TABLE run_routes ADD COLUMN client_platform TEXT",
  ],
};
