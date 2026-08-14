import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V021_CLEAR_LEGACY_CONTROLLER_ROUTES: SqlMigration = {
  id: 21,
  name: "clear_legacy_controller_routes",
  statements: [
    "DELETE FROM surface_routes WHERE pid LIKE 'proc:master-control:%'",
  ],
};
