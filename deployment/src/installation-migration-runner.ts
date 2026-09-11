import * as z from "zod/mini";
import { ADOPTION_STATE_TABLE, adoptionDigest, quoteAdoptionIdentifier as quote } from "./installation-migration-adoption-state.ts";
import { assertMigrationFreeze, readMigrationFreeze, readMigrationSchema } from "./installation-migration-freeze.ts";
import { migrationD1Read, type MigrationD1Database, type MigrationD1Statement } from "./installation-migration-d1.ts";
import { installationMigrationInventory, type InstallationMigrationOwner } from "./installation-migration-inventory.ts";

export type OwnedInstallationMigration = { owner: InstallationMigrationOwner; name: string; sql: string };
const SOURCE_TABLE = "installation_migration_sources";
const SOURCE_SQL = `CREATE TABLE installation_migration_sources (
  owner TEXT NOT NULL CHECK (owner IN ('directory', 'policy')),
  name TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  PRIMARY KEY (owner, name)
)`;
const ledgerRow = z.object({ id: z.string(), name: z.string(), applied_at: z.string() });
const sourceRow = z.object({ owner: z.enum(["directory", "policy"]), name: z.string(), sha256: z.string() });
const normalize = (sql: string): string => sql.replace(/\s+/g, " ").trim();

/** Runs reviewed forward SQL only after both owners have completed adoption. */
export async function runOwnedInstallationMigrations(input: {
  database: MigrationD1Database;
  operationId: string;
  sources: readonly OwnedInstallationMigration[];
}): Promise<{ applied: string[] }> {
  const sources = [...input.sources].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  if (new Set(sources.map((source) => source.name)).size !== sources.length
    || sources.some((source) => !/^\d{4}_[a-z0-9_]+\.sql$/.test(source.name) || !source.sql.trim())) {
    throw new Error("Owner migrations require unique ordered source names");
  }
  for (const historical of installationMigrationInventory) {
    const source = sources.find((entry) => entry.name === historical.name);
    if (!source || source.owner !== historical.owner || adoptionDigest(source.sql) !== historical.sha256) {
      throw new Error("Owner sources disagree with the historical migration inventory");
    }
  }
  if (sources.some((source) => Number(source.name.slice(0, 4)) <= 12
    && !installationMigrationInventory.some((entry) => entry.name === source.name))) {
    throw new Error("Unrecognized historical migration source");
  }
  const applied: string[] = [];
  // Re-read guards before each transaction; a failed/lost reply is reconciled
  // from the ledger and immutable source receipt on the next invocation.
  for (;;) {
    const freeze = await readMigrationFreeze(input.database);
    if (!freeze || freeze.phase !== "released" || !freeze.preconditionSha256 || !freeze.postconditionSha256
      || freeze.context.operationId !== input.operationId
      || freeze.context.accountId !== input.database.identity.accountId
      || freeze.context.databaseId !== input.database.identity.databaseId) {
      throw new Error("Both migration owners must complete the reviewed remote handoff before forward migrations");
    }
    const receipt = await migrationD1Read(input.database, `SELECT record FROM ${ADOPTION_STATE_TABLE} WHERE id = 1`);
    const completed = z.object({ operationId: z.literal(input.operationId), completedPreconditionSha256: z.literal(freeze.postconditionSha256),
      handoffs: z.array(z.object({ owner: z.enum(["directory", "policy"]), ledger: z.string(), state: z.literal("complete") })) })
      .parse(JSON.parse(z.string().parse(receipt[0]?.record)));
    if (receipt.length !== 1 || completed.handoffs.length !== 2 || new Set(completed.handoffs.map((owner) => owner.owner)).size !== 2
      || completed.handoffs.some((owner) => owner.ledger !== (owner.owner === "directory" ? freeze.context.directoryLedger : freeze.context.policyLedger))) {
      throw new Error("Forward migrations require matching completed owner receipts");
    }
    const schema = await readMigrationSchema(input.database);
    const sourceObject = schema.find((object) => object.name === SOURCE_TABLE);
    if (sourceObject && (sourceObject.type !== "table" || normalize(sourceObject.sql ?? "") !== normalize(SOURCE_SQL)
      || schema.some((object) => object.tbl_name === SOURCE_TABLE && object.name !== SOURCE_TABLE))) {
      throw new Error("Unrecognized immutable migration source ledger");
    }
    const recorded = sourceObject ? (await migrationD1Read(input.database, `SELECT owner, name, sha256 FROM ${SOURCE_TABLE}`)).map((row) => sourceRow.parse(row)) : [];
    const statements: MigrationD1Statement[] = [assertMigrationFreeze(freeze, schema)];
    if (!sourceObject) statements.push({ sql: SOURCE_SQL });
    const pending: OwnedInstallationMigration[] = [];
    const nextIds = new Map<InstallationMigrationOwner, string>();
    const ledgers = { directory: freeze.context.directoryLedger, policy: freeze.context.policyLedger };
    const allRecordedNames = new Set<string>();
    for (const owner of ["directory", "policy"] as const) {
      const ledger = quote(ledgers[owner]);
      const rows = (await migrationD1Read(input.database, `SELECT CAST(id AS TEXT) AS id, name, applied_at FROM ${ledger} ORDER BY CAST(id AS INTEGER)`))
        .map((row) => ledgerRow.parse(row));
      const expected = sources.filter((source) => source.owner === owner);
      if (rows.some((row, index) => !/^\d+$/.test(row.id) || row.name !== expected[index]?.name)
        || new Set(rows.map((row) => row.id)).size !== rows.length) throw new Error("Owner ledger is not a prefix of its reviewed source inventory");
      // Data can change after a read. Force a failing CHECK in this same batch
      // if another runner changed either ledger before these actions commit.
      statements.push({
        sql: `UPDATE installation_migration_freeze SET assertion = CASE WHEN
          (SELECT json_group_array(json_array(CAST(id AS TEXT), name, applied_at)) FROM
            (SELECT id, name, applied_at FROM ${ledger} ORDER BY CAST(id AS INTEGER))) = ? THEN 1 ELSE 0 END WHERE id = 1`,
        params: [JSON.stringify(rows.map((row) => [row.id, row.name, row.applied_at]))],
      });
      for (const row of rows) {
        allRecordedNames.add(row.name);
        const source = expected.find((entry) => entry.name === row.name)!;
        const checksum = adoptionDigest(source.sql);
        const proof = recorded.find((entry) => entry.owner === owner && entry.name === row.name);
        if (sourceObject && (!proof || proof.sha256 !== checksum)) throw new Error("Applied migration source changed or lacks its immutable receipt");
        if (!sourceObject) {
          if (!installationMigrationInventory.some((entry) => entry.owner === owner && entry.name === row.name)) {
            throw new Error("Cannot infer provenance for a forward migration applied by another runner");
          }
          statements.push({ sql: `INSERT INTO ${SOURCE_TABLE} (owner, name, sha256) VALUES (?, ?, ?)`, params: [owner, row.name, checksum] });
        }
      }
      pending.push(...expected.slice(rows.length));
      const maxId = rows.reduce((maximum, row) => BigInt(row.id) > maximum ? BigInt(row.id) : maximum, 0n);
      nextIds.set(owner, String(maxId + 1n).padStart(5, "0"));
    }
    if (recorded.some((entry) => !allRecordedNames.has(entry.name)
      || !sources.some((source) => source.name === entry.name && source.owner === entry.owner))) {
      throw new Error("Migration source receipt does not match an applied owner record");
    }
    pending.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const next = pending[0];
    if (next) {
      // D1 accepts multiple SQL statements inside one batch item. Keeping the
      // complete migration intact preserves trigger bodies and SQL comments.
      statements.push({ sql: next.sql }, {
        sql: `INSERT INTO ${quote(ledgers[next.owner])} (id, name, applied_at) VALUES (?, ?, datetime('now'))`,
        params: [nextIds.get(next.owner)!, next.name],
      }, { sql: `INSERT INTO ${SOURCE_TABLE} (owner, name, sha256) VALUES (?, ?, ?)`,
        params: [next.owner, next.name, adoptionDigest(next.sql)] });
    }
    if (!next && sourceObject) return { applied };
    await input.database.batch(statements);
    if (next) applied.push(next.name);
  }
}
