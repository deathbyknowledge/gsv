import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V046_ADD_ACCOUNT_PASSKEYS: SqlMigration = {
  id: 46,
  name: "add_account_passkeys",
  statements: [
    `CREATE TABLE account_passkey_users (uid INTEGER PRIMARY KEY, user_handle TEXT NOT NULL UNIQUE)`,
    `CREATE TABLE account_passkeys (
      id TEXT PRIMARY KEY,
      uid INTEGER NOT NULL,
      public_key BLOB NOT NULL,
      counter INTEGER NOT NULL,
      transports_json TEXT NOT NULL,
      device_type TEXT NOT NULL,
      backed_up INTEGER NOT NULL,
      label TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER
    )`,
    `CREATE INDEX account_passkeys_uid ON account_passkeys(uid)`,
    `CREATE TABLE account_passkey_challenges (
      id TEXT PRIMARY KEY,
      uid INTEGER NOT NULL,
      purpose TEXT NOT NULL CHECK (purpose IN ('register', 'authenticate')),
      challenge TEXT NOT NULL,
      origin TEXT NOT NULL,
      rp_id TEXT NOT NULL,
      credential_epoch INTEGER NOT NULL,
      label TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER,
      response_hash TEXT,
      credential_id TEXT
    )`,
    `CREATE INDEX account_passkey_challenges_uid ON account_passkey_challenges(uid, expires_at)`,
  ],
};
