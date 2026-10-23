import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V072_SHIP_CALLS: SqlMigration = {
  id: 72,
  name: "ship_calls",
  statements: [
    `
      CREATE TABLE did_documents (
        did TEXT PRIMARY KEY,
        resolved_json TEXT NOT NULL,
        resolved_at INTEGER NOT NULL,
        used_at INTEGER NOT NULL
      )
    `,
    "CREATE INDEX did_documents_use ON did_documents (used_at)",
    `
      CREATE TABLE service_auth_nonces (
        issuer TEXT NOT NULL,
        jti TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (issuer, jti)
      ) WITHOUT ROWID
    `,
    "CREATE INDEX service_auth_nonces_expiry ON service_auth_nonces (expires_at)",
  ],
};
