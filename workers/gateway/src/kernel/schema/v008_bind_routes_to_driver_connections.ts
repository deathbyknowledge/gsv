import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V008_BIND_ROUTES_TO_DRIVER_CONNECTIONS: SqlMigration = {
  id: 8,
  name: "bind_routes_to_driver_connections",
  statements: [
    `
      ALTER TABLE routing_table ADD COLUMN driver_connection_id TEXT
    `,
  ],
};
