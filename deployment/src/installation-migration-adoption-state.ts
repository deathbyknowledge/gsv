import { createHash } from "node:crypto";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import * as z from "zod/mini";

export type AdoptionReader = Pick<DatabaseSync, "prepare">;
export const ADOPTION_STATE_TABLE = "installation_migration_adoption";
export const ADOPTION_STATE_SQL = `CREATE TABLE installation_migration_adoption (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  record TEXT NOT NULL
)`;

const checksum = z.string().check(z.regex(/^[a-f0-9]{64}$/));
const handoff = z.strictObject({
  operationId: z.string(), owner: z.enum(["directory", "policy"]), ledger: z.string(),
  evidenceSha256: checksum, state: z.enum(["seeding", "complete"]),
});
const stateSchema = z.strictObject({
  format: z.literal(1), operationId: z.string(), evidenceSha256: checksum,
  approvedPreconditionSha256: checksum, completedPreconditionSha256: z.nullable(checksum),
  resetProofsSha256: checksum, handoffs: z.array(handoff),
});
export type LocalAdoptionState = z.infer<typeof stateSchema>;

export const adoptionDigest = (value: string): string => createHash("sha256").update(value).digest("hex");
export const quoteAdoptionIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

/** This one metadata table is excluded only after its exact schema is verified. */
export function readLocalAdoptionState(db: AdoptionReader): LocalAdoptionState | null {
  const objects = db.prepare("SELECT type, sql FROM sqlite_schema WHERE name = ? OR tbl_name = ?")
    .all(ADOPTION_STATE_TABLE, ADOPTION_STATE_TABLE);
  if (objects.length === 0) return null;
  const object = z.object({ type: z.literal("table"), sql: z.string() }).safeParse(objects[0]);
  if (objects.length !== 1 || !object.success
    || object.data.sql.replace(/\s+/g, " ").trim() !== ADOPTION_STATE_SQL.replace(/\s+/g, " ").trim()) {
    throw new Error("Unrecognized local adoption metadata schema");
  }
  const rows = db.prepare(`SELECT id, record FROM ${ADOPTION_STATE_TABLE}`).all();
  if (rows.length === 0) return null;
  const row = z.object({ id: z.literal(1), record: z.string() }).safeParse(rows[0]);
  if (rows.length !== 1 || !row.success) throw new Error("Unrecognized local adoption metadata record");
  return stateSchema.parse(JSON.parse(row.data.record));
}

type OmittedRow = { table: string; key: Record<string, string> };

function isInteger(value: SQLOutputValue): value is bigint {
  return typeof value === "bigint";
}

function isReal(value: SQLOutputValue): value is number {
  return typeof value === "number";
}

/** Hash rows incrementally; retain neither credentials nor policy contents in evidence. */
export function adoptionRowsDigest(
  db: AdoptionReader,
  excludedTables: readonly string[] = [],
  omittedRows: readonly OmittedRow[] = [],
): string {
  const hash = createHash("sha256");
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all();
  for (const table of tables) {
    const name = z.string().parse(table.name);
    if (name === ADOPTION_STATE_TABLE || excludedTables.includes(name)) continue;
    const columns = db.prepare(`PRAGMA table_xinfo(${quoteAdoptionIdentifier(name)})`).all()
      .map((column) => z.string().parse(column.name));
    hash.update(JSON.stringify([name, columns]));
    const ordering = columns.flatMap((column) => [
      `typeof(${quoteAdoptionIdentifier(column)})`, `${quoteAdoptionIdentifier(column)} COLLATE BINARY`,
    ]).join(", ");
    const statement = db.prepare(`SELECT * FROM ${quoteAdoptionIdentifier(name)} ORDER BY ${ordering}`);
    statement.setReadBigInts(true);
    for (const row of statement.iterate()) {
      if (omittedRows.some((omitted) => omitted.table === name
        && Object.entries(omitted.key).every(([key, value]) => row[key] === value))) continue;
      hash.update(JSON.stringify(columns.map((column) => {
        const value = row[column];
        if (isInteger(value)) return ["integer", value.toString()];
        if (isReal(value)) {
          const bytes = Buffer.alloc(8);
          bytes.writeDoubleBE(value);
          return ["real", bytes.toString("hex")];
        }
        if (value instanceof Uint8Array) return ["blob", Buffer.from(value).toString("hex")];
        return ["value", value];
      })));
    }
  }
  return hash.digest("hex");
}
