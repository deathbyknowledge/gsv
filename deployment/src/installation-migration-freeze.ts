import { isDeepStrictEqual } from "node:util";
import { DatabaseSync } from "node:sqlite";
import * as z from "zod/mini";
import { planInstallationMigrationAdoption, type HistoricalResetProof, type MigrationAdoptionContext, type MigrationOwnerHandoff } from "./installation-migration-adoption.ts";
import { adoptionDigest, quoteAdoptionIdentifier as quote } from "./installation-migration-adoption-state.ts";
import { migrationD1Read, type MigrationD1Database, type MigrationD1Statement } from "./installation-migration-d1.ts";

export const MIGRATION_FREEZE_TABLE = "installation_migration_freeze";
export const MIGRATION_FREEZE_SQL = `CREATE TABLE installation_migration_freeze (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  record TEXT NOT NULL,
  assertion INTEGER NOT NULL CHECK (assertion = 1)
)`;
const TRIGGER_PREFIX = "installation_migration_freeze_";
const schemaRow = z.object({ type: z.string(), name: z.string(), tbl_name: z.string(), sql: z.nullable(z.string()) });
export type MigrationSchemaRow = z.infer<typeof schemaRow>;
export type MigrationFreezeRecord = {
  format: 1;
  context: MigrationAdoptionContext;
  phase: "frozen" | "adopted" | "released" | "cancelled";
  tables: string[];
  handoffs: readonly MigrationOwnerHandoff[];
  resetEvidenceSha256: string;
  preconditionSha256: string | null;
  postconditionSha256: string | null;
};
const checksum = z.string().check(z.regex(/^[a-f0-9]{64}$/));
const revision = z.string().check(z.regex(/^[a-f0-9]{40}$/));
const ledgerName = z.string().check(z.regex(/^[a-z][a-z0-9_]*$/));
export const migrationAdoptionContextSchema = z.strictObject({
  operationId: z.string(), environment: z.string(), accountId: z.string(), databaseId: z.string(),
  legacyRunnerRevision: revision, directoryRunnerRevision: revision, policyRunnerRevision: revision,
  legacySourceEvidenceSha256: checksum, legacyRunnerFrozen: z.literal(true),
  legacyLedger: ledgerName, directoryLedger: z.literal("installation_migrations"), policyLedger: ledgerName,
});
const handoffSchema = z.strictObject({ operationId: z.string(), owner: z.enum(["directory", "policy"]),
  ledger: ledgerName, evidenceSha256: checksum, state: z.enum(["seeding", "complete"]) });
const recordSchema = z.strictObject({
  format: z.literal(1), context: migrationAdoptionContextSchema,
  phase: z.enum(["frozen", "adopted", "released", "cancelled"]), tables: z.array(z.string()),
  handoffs: z.array(handoffSchema), resetEvidenceSha256: checksum,
  preconditionSha256: z.nullable(checksum), postconditionSha256: z.nullable(checksum),
});

export async function readMigrationSchema(database: MigrationD1Database): Promise<MigrationSchemaRow[]> {
  return (await migrationD1Read(database,
    "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY type, name",
  )).map((row) => schemaRow.parse(row));
}

export function freezeTriggers(table: string): MigrationD1Statement[] {
  return ["INSERT", "UPDATE", "DELETE"].map((operation) => ({
    sql: `CREATE TRIGGER ${quote(`${TRIGGER_PREFIX}${table}_${operation.toLowerCase()}`)} BEFORE ${operation} ON ${quote(table)}
      WHEN COALESCE((SELECT json_extract(record, '$.phase') FROM ${MIGRATION_FREEZE_TABLE} WHERE id = 1), 'frozen') != 'applying'
      BEGIN SELECT RAISE(ABORT, 'installation migration handoff has frozen writes'); END`,
  }));
}

export function dropFreezeTriggers(tables: readonly string[]): MigrationD1Statement[] {
  return tables.flatMap((table) => ["insert", "update", "delete"].map((operation) => ({
    sql: `DROP TRIGGER ${quote(`${TRIGGER_PREFIX}${table}_${operation}`)}`,
  })));
}

const compareSqlText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

type WritableFreezeRecord = MigrationFreezeRecord | (Omit<MigrationFreezeRecord, "phase"> & { phase: "applying" });

function freezeRecordJson(record: WritableFreezeRecord): string {
  // Keep one property order for persisted evidence and exact SQL comparisons.
  return JSON.stringify({ ...recordSchema.parse({ ...record, phase: "frozen" }), phase: record.phase });
}

const normalizeSql = (sql: string): string => sql.replace(/\s+/g, " ").trim();

export async function readMigrationFreeze(database: MigrationD1Database): Promise<MigrationFreezeRecord | null> {
  const schema = await readMigrationSchema(database);
  const table = schema.find((object) => object.name === MIGRATION_FREEZE_TABLE);
  if (!table) {
    if (schema.some((object) => object.name.startsWith(TRIGGER_PREFIX))) throw new Error("Orphaned migration freeze triggers");
    return null;
  }
  if (table.type !== "table" || table.sql === null || normalizeSql(table.sql) !== normalizeSql(MIGRATION_FREEZE_SQL)
    || schema.some((object) => object.tbl_name === MIGRATION_FREEZE_TABLE && object.name !== MIGRATION_FREEZE_TABLE)) {
    throw new Error("Unrecognized remote migration freeze schema");
  }
  const rows = await migrationD1Read(database, `SELECT id, record, assertion FROM ${MIGRATION_FREEZE_TABLE}`);
  const row = z.object({ id: z.literal(1), record: z.string(), assertion: z.literal(1) }).parse(rows[0]);
  if (rows.length !== 1) throw new Error("Remote migration freeze requires one operation record");
  const record = recordSchema.parse(JSON.parse(row.record));
  const expected = record.phase === "released" ? [record.context.legacyLedger]
    : record.phase === "cancelled" ? [] : record.tables;
  const expectedSql = expected.flatMap(freezeTriggers).map(({ sql }) => normalizeSql(sql));
  const actual = schema.filter((object) => object.name.startsWith(TRIGGER_PREFIX));
  if (actual.length !== expectedSql.length || actual.some((object) => object.type !== "trigger" || object.sql === null
    || !expectedSql.includes(normalizeSql(object.sql)))) throw new Error("Remote migration freeze is incomplete or has changed");
  return record;
}

export function assertMigrationFreeze(record: MigrationFreezeRecord, schema: readonly MigrationSchemaRow[]): MigrationD1Statement {
  const observed = JSON.stringify(schema.map((row) => [row.type, row.name, row.tbl_name, row.sql]));
  return {
    sql: `INSERT INTO ${MIGRATION_FREEZE_TABLE} (id, record, assertion)
      VALUES (1, ?, CASE WHEN (SELECT record FROM ${MIGRATION_FREEZE_TABLE} WHERE id = 1) = ?
        AND (SELECT json_group_array(json_array(type, name, tbl_name, sql)) FROM
          (SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY type, name)) = ?
        THEN 1 ELSE 0 END)
      ON CONFLICT(id) DO UPDATE SET assertion = excluded.assertion`,
    params: [freezeRecordJson(record), freezeRecordJson(record), observed],
  };
}

export const writeMigrationFreeze = (record: WritableFreezeRecord): MigrationD1Statement => ({
  sql: `UPDATE ${MIGRATION_FREEZE_TABLE} SET record = ? WHERE id = 1`, params: [freezeRecordJson(record)],
});

/** Reconstruct only a local snapshot; no historical SQL is sent back to D1. */
export async function captureMigrationSnapshot(database: MigrationD1Database, record?: MigrationFreezeRecord): Promise<DatabaseSync> {
  const before = await readMigrationSchema(database);
  // SQLite owns this temporary database and deletes it on close; large
  // snapshots can spill to disk instead of retaining all Accounts rows in RAM.
  const local = new DatabaseSync("");
  try {
    local.exec("PRAGMA foreign_keys = OFF");
    const application = before.filter((object) => object.name !== MIGRATION_FREEZE_TABLE && !object.name.startsWith(TRIGGER_PREFIX));
    for (const object of application.filter((object) => object.type === "table")) {
      if (object.sql === null || !/^CREATE TABLE\b/i.test(object.sql)) throw new Error("Unsupported migration snapshot table");
      local.exec(object.sql);
    }
    for (const object of application.filter((object) => object.type === "table")) {
      const table = quote(object.name);
      const columns = local.prepare(`PRAGMA table_info(${table})`).all().map((row) => z.string().parse(row.name));
      const values = columns.map((column) => {
        const name = quote(column);
        return `json_array(typeof(${name}), CASE typeof(${name}) WHEN 'integer' THEN CAST(${name} AS TEXT)
          WHEN 'real' THEN printf('%!.17g', ${name}) WHEN 'blob' THEN hex(${name}) ELSE ${name} END)`;
      });
      const insert = local.prepare(`INSERT INTO ${table} (${columns.map(quote).join(",")}) VALUES (${columns.map(() => "?").join(",")})`);
      let offset = 0;
      for (;;) {
        const rows = await migrationD1Read(database, `SELECT json_array(${values.join(",")}) AS encoded FROM ${table} ORDER BY ${columns.map(quote).join(",")} LIMIT 200 OFFSET ?`, [String(offset)]);
        for (const row of rows) {
          const encoded = z.array(z.tuple([z.enum(["null", "integer", "real", "text", "blob"]), z.nullable(z.string())]))
            .parse(JSON.parse(z.string().parse(row.encoded)));
          insert.run(...encoded.map(([type, value]) => type === "null" ? null : type === "integer" ? BigInt(value!)
            : type === "real" ? Number(value) : type === "blob" ? Buffer.from(value!, "hex") : value));
        }
        if (rows.length < 200) break;
        offset += rows.length;
      }
    }
    for (const object of application.filter((object) => object.type !== "table" && object.sql !== null)) local.exec(object.sql!);
    if (local.prepare("SELECT name FROM sqlite_schema WHERE name = 'sqlite_sequence'").get()) {
      const sequence = await migrationD1Read(database, "SELECT name, CAST(seq AS TEXT) AS sequence FROM sqlite_sequence ORDER BY name");
      local.exec("DELETE FROM sqlite_sequence");
      for (const row of sequence) local.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)")
        .run(z.string().parse(row.name), BigInt(z.string().parse(row.sequence)));
    }
    local.exec("PRAGMA foreign_keys = ON");
    if (record) {
      await database.batch([assertMigrationFreeze(record, before)]);
      if (!isDeepStrictEqual(await readMigrationFreeze(database), record)) throw new Error("Snapshot lost its remote freeze");
    }
    return local;
  } catch (error) {
    local.close();
    throw error;
  }
}

export async function freezeInstallationMigrations(input: {
  database: MigrationD1Database;
  context: MigrationAdoptionContext;
  sources: readonly { name: string; sql: string }[];
  handoffs?: readonly MigrationOwnerHandoff[];
  resetProofs?: readonly HistoricalResetProof[];
}): Promise<MigrationFreezeRecord> {
  if (input.database.identity.accountId !== input.context.accountId
    || input.database.identity.databaseId !== input.context.databaseId) {
    throw new Error("Remote database does not match the reviewed adoption identity");
  }
  const resetEvidenceSha256 = migrationResetEvidenceDigest(input.resetProofs ?? []);
  const existing = await readMigrationFreeze(input.database);
  if (existing) {
    if (!isDeepStrictEqual(existing.context, input.context)
      || existing.resetEvidenceSha256 !== resetEvidenceSha256
      || !isDeepStrictEqual(existing.handoffs, input.handoffs ?? [])) {
      throw new Error("Remote migration freeze belongs to different reviewed evidence");
    }
    if (existing.phase !== "cancelled") return existing;
  }
  const schema = await readMigrationSchema(input.database);
  const local = await captureMigrationSnapshot(input.database);
  try {
    // Validate source and schema before any freeze. Reset evidence is checked
    // against a stable snapshot after the database-enforced freeze is in place.
    const plan = planInstallationMigrationAdoption({ database: local, context: input.context, sources: input.sources,
      handoffs: input.handoffs, resetProofs: input.resetProofs });
    if (plan.resetImportsRequireMigrations.length > 0) throw new Error("Apply reviewed preparation migrations before freezing the database");
  } finally { local.close(); }
  const record: MigrationFreezeRecord = {
    format: 1, context: input.context, phase: "frozen",
    tables: schema.filter((object) => object.type === "table" && object.name !== MIGRATION_FREEZE_TABLE).map((object) => object.name),
    handoffs: input.handoffs ?? [], resetEvidenceSha256,
    preconditionSha256: null, postconditionSha256: null,
  };
  const initial: MigrationD1Statement[] = existing ? [assertMigrationFreeze(existing, schema)] : [{ sql: MIGRATION_FREEZE_SQL }];
  initial.push(existing ? writeMigrationFreeze(record) : {
    sql: `INSERT INTO ${MIGRATION_FREEZE_TABLE} (id, record, assertion) VALUES (1, ?, 1)`, params: [freezeRecordJson(record)],
  });
  initial.push(...record.tables.flatMap(freezeTriggers));
  // Comparing the complete schema in the same batch prevents a concurrent
  // migration from silently adding an unfrozen table between discovery and freeze.
  const expected = [...schema.filter((object) => object.name !== MIGRATION_FREEZE_TABLE),
    { type: "table", name: MIGRATION_FREEZE_TABLE, tbl_name: MIGRATION_FREEZE_TABLE, sql: MIGRATION_FREEZE_SQL },
    ...record.tables.flatMap((table) => freezeTriggers(table).map(({ sql }) => ({
      type: "trigger", name: /^CREATE TRIGGER "([^"]+)"/.exec(sql)![1], tbl_name: table, sql,
    }))),
  ].sort((a, b) => compareSqlText(a.type, b.type) || compareSqlText(a.name, b.name));
  initial.push(assertMigrationFreeze(record, expected));
  await input.database.batch(initial);
  const confirmed = await readMigrationFreeze(input.database);
  if (!confirmed) throw new Error("Remote migration freeze did not persist");
  return confirmed;
}

export const migrationResetEvidenceDigest = (proofs: readonly HistoricalResetProof[]): string => adoptionDigest(JSON.stringify(proofs.map((proof) => ({
  operationId: proof.operationId, previousInstallationId: proof.previousInstallationId,
  replacementInstallationId: proof.replacementInstallationId, kind: proof.kind, evidenceSha256: proof.evidenceSha256,
  participantId: proof.participantId, preparedAt: proof.preparedAt,
}))));
