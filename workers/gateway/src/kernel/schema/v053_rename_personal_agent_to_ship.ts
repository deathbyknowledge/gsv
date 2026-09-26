import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V053_RENAME_PERSONAL_AGENT_TO_SHIP: SqlMigration = {
  id: 53,
  name: "rename_personal_agent_to_ship",
  statements: [
    "ALTER TABLE passwd ADD COLUMN repo_owner TEXT",
    "ALTER TABLE processes ADD COLUMN repo_owner TEXT",
    // Keep numeric ownership and physical home/repository paths unchanged.
    // A pre-existing ship account or namespace belongs to its current owner.
    `CREATE TABLE personal_agent_rename_v053 (uid INTEGER PRIMARY KEY, gid INTEGER NOT NULL)`,
    `INSERT INTO personal_agent_rename_v053 (uid, gid)
      SELECT uid, gid FROM passwd
      WHERE username = 'algo' AND uid IN (SELECT agent_uid FROM personal_agents)
        AND NOT EXISTS (SELECT 1 FROM passwd WHERE username = 'ship' OR home = '/home/ship')
        AND NOT EXISTS (SELECT 1 FROM groups WHERE name = 'ship')
        AND EXISTS (SELECT 1 FROM groups WHERE name = 'algo' AND groups.gid = passwd.gid)`,
    `UPDATE shadow SET username = 'ship'
      WHERE username = 'algo' AND EXISTS (SELECT 1 FROM personal_agent_rename_v053)`,
    `UPDATE groups SET name = 'ship'
      WHERE name = 'algo' AND gid IN (SELECT gid FROM personal_agent_rename_v053)`,
    `UPDATE groups SET members = TRIM(REPLACE(',' || members || ',', ',algo,', ',ship,'), ',')
      WHERE EXISTS (SELECT 1 FROM personal_agent_rename_v053)`,
    `UPDATE processes SET username = 'ship', repo_owner = 'algo'
      WHERE uid IN (SELECT uid FROM personal_agent_rename_v053)`,
    `UPDATE passwd SET username = 'ship', repo_owner = 'algo',
      gecos = CASE WHEN gecos IN ('Algo', 'algo') OR gecos = (
        SELECT owner.username || '''s agent' FROM personal_agents
        JOIN passwd AS owner ON owner.uid = personal_agents.owner_uid WHERE agent_uid = passwd.uid
      ) THEN 'Ship' ELSE gecos END
      WHERE uid IN (SELECT uid FROM personal_agent_rename_v053)`,
    `DROP TABLE personal_agent_rename_v053`,
  ],
};
