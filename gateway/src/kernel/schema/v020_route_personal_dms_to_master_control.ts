import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V020_ROUTE_PERSONAL_DMS_TO_MASTER_CONTROL: SqlMigration = {
  id: 20,
  name: "route_personal_dms_to_master_control",
  statements: [
    `
      DELETE FROM surface_routes
      WHERE surface_kind = 'dm'
        AND EXISTS (
          SELECT 1
          FROM processes
          JOIN personal_agents ON personal_agents.agent_uid = processes.uid
          WHERE processes.process_id = surface_routes.pid
            AND personal_agents.owner_uid = surface_routes.uid
        )
    `,
  ],
};
