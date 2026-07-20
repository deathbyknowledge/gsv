import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V017_BIND_ADAPTER_RUN_ROUTES: SqlMigration = {
  id: 17,
  name: "bind_adapter_routes",
  statements: [
    "ALTER TABLE run_routes ADD COLUMN actor_id TEXT",
    "ALTER TABLE run_routes ADD COLUMN link_generation INTEGER",
    "ALTER TABLE identity_links ADD COLUMN generation INTEGER NOT NULL DEFAULT 1",
    `
      CREATE TABLE identity_link_generations (
        adapter    TEXT    NOT NULL,
        account_id TEXT    NOT NULL,
        actor_id   TEXT    NOT NULL,
        generation INTEGER NOT NULL CHECK (generation > 0),
        PRIMARY KEY (adapter, account_id, actor_id)
      )
    `,
    `
      INSERT INTO identity_link_generations (adapter, account_id, actor_id, generation)
      SELECT adapter, account_id, actor_id, generation
      FROM identity_links
    `,
  ],
};
