import type { SqlMigration } from "../../schema/runner";

/**
 * The DID cache keeps the tombstone a lookup finds as a row without a
 * document, so a Ship can end a contact on what an earlier lookup found.
 */
export const KERNEL_V078_REMEMBER_DEACTIVATED_DIDS: SqlMigration = {
  id: 78,
  name: "remember_deactivated_dids",
  statements: [
    `CREATE TABLE did_documents_v078 (
      did TEXT PRIMARY KEY,
      resolved_json TEXT,
      resolved_at INTEGER NOT NULL,
      used_at INTEGER NOT NULL
    )`,
    `INSERT INTO did_documents_v078 (did, resolved_json, resolved_at, used_at)
      SELECT did, resolved_json, resolved_at, used_at FROM did_documents`,
    "DROP TABLE did_documents",
    "ALTER TABLE did_documents_v078 RENAME TO did_documents",
    "CREATE INDEX did_documents_use ON did_documents (used_at)",
  ],
};
