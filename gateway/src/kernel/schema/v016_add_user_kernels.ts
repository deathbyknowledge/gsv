import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V016_ADD_USER_KERNELS: SqlMigration = {
  id: 16,
  name: "add_user_kernels",
  statements: [
    `
      CREATE TABLE IF NOT EXISTS account_identities (
        username   TEXT    NOT NULL PRIMARY KEY CHECK (
          length(username) BETWEEN 1 AND 32
          AND username GLOB '[a-z_]*'
          AND username NOT GLOB '*[^a-z0-9_-]*'
        ),
        uid        INTEGER NOT NULL UNIQUE CHECK (
          typeof(uid) = 'integer'
          AND uid BETWEEN 0 AND 9007199254740991
        ),
        kind       TEXT    NOT NULL CHECK (kind IN ('human', 'agent', 'system')),
        state      TEXT    NOT NULL CHECK (state IN ('active', 'retired')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        retired_at INTEGER,
        CHECK ((username = 'root') = (uid = 0))
      )
    `,
    // This must stay a plain INSERT. A malformed legacy identity aborts the
    // whole migration instead of being normalized, remapped, or skipped.
    `
      INSERT INTO account_identities (
        username, uid, kind, state, created_at, updated_at, retired_at
      )
      SELECT
        passwd.username,
        passwd.uid,
        CASE
          WHEN passwd.uid < 1000 THEN 'system'
          WHEN EXISTS (
            SELECT 1 FROM personal_agents
            WHERE personal_agents.agent_uid = passwd.uid
          ) THEN 'agent'
          WHEN COALESCE(shadow.hash, '!') IN ('', '!', '*') THEN 'agent'
          ELSE 'human'
        END,
        'active',
        unixepoch() * 1000,
        unixepoch() * 1000,
        NULL
      FROM passwd
      LEFT JOIN shadow ON shadow.username = passwd.username
    `,
    `
      CREATE TABLE IF NOT EXISTS user_kernels (
        username   TEXT    NOT NULL PRIMARY KEY CHECK (
          length(username) BETWEEN 1 AND 32
          AND username GLOB '[a-z_]*'
          AND username NOT GLOB '*[^a-z0-9_-]*'
        ),
        uid        INTEGER NOT NULL UNIQUE CHECK (
          typeof(uid) = 'integer'
          AND uid BETWEEN 0 AND 9007199254740991
        ),
        lifecycle  TEXT    NOT NULL CHECK (
          lifecycle IN ('legacy', 'provisioning', 'active', 'suspended', 'retired')
        ),
        generation INTEGER NOT NULL CHECK (generation > 0),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        retired_at INTEGER,
        CHECK ((username = 'root') = (uid = 0)),
        FOREIGN KEY (username) REFERENCES account_identities(username)
      )
    `,
    `
      INSERT INTO user_kernels (
        username, uid, lifecycle, generation, created_at, updated_at, retired_at
      )
      SELECT
        passwd.username,
        passwd.uid,
        'legacy',
        1,
        unixepoch() * 1000,
        unixepoch() * 1000,
        NULL
      FROM passwd
      LEFT JOIN shadow ON shadow.username = passwd.username
      WHERE passwd.uid = 0
         OR passwd.uid IN (SELECT owner_uid FROM personal_agents)
         OR (
           passwd.uid >= 1000
           AND COALESCE(shadow.hash, '!') NOT IN ('', '!', '*')
         )
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_user_kernels_lifecycle
      ON user_kernels (lifecycle, updated_at)
    `,
  ],
};
