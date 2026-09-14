import { isDeepStrictEqual } from "node:util";
import { planInstallationMigrationAdoption, type HistoricalResetProof, type MigrationAdoptionContext, type MigrationOwnerHandoff } from "./installation-migration-adoption.ts";
import { executeLocalInstallationMigrationAdoption } from "./installation-migration-adoption-executor.ts";
import { ADOPTION_STATE_SQL, ADOPTION_STATE_TABLE, quoteAdoptionIdentifier as quote, readLocalAdoptionState } from "./installation-migration-adoption-state.ts";
import { type MigrationD1Database, type MigrationD1Statement } from "./installation-migration-d1.ts";
import {
  assertMigrationFreeze, captureMigrationSnapshot, dropFreezeTriggers, freezeInstallationMigrations,
  freezeTriggers, migrationResetEvidenceDigest, readMigrationFreeze, readMigrationSchema,
  writeMigrationFreeze, type MigrationFreezeRecord,
} from "./installation-migration-freeze.ts";

export type RemoteMigrationAdoptionInput = {
  database: MigrationD1Database;
  context: MigrationAdoptionContext;
  sources: readonly { name: string; sql: string }[];
  handoffs?: readonly MigrationOwnerHandoff[];
  resetProofs?: readonly HistoricalResetProof[];
};

export type RemoteMigrationAdoptionReceipt = {
  operationId: string;
  phase: "released";
  preconditionSha256: string;
  postconditionSha256: string;
};

/** Creates a durable write freeze. The caller owns snapshot custody and closure. */
export async function prepareRemoteInstallationMigrationAdoption(input: RemoteMigrationAdoptionInput) {
  const record = await freezeInstallationMigrations(input);
  if (record.phase !== "frozen") throw new Error("Adoption is already committed; reconcile its durable receipt");
  const snapshot = await captureMigrationSnapshot(input.database, record);
  try {
    const plan = planInstallationMigrationAdoption({ ...input, database: snapshot });
    if (plan.resetImportsRequireMigrations.length > 0) throw new Error("Apply reviewed preparation migrations before the handoff");
    return { record, snapshot, plan };
  } catch (error) { snapshot.close(); throw error; }
}

function requireOperation(input: RemoteMigrationAdoptionInput, record: MigrationFreezeRecord): void {
  if (input.database.identity.accountId !== input.context.accountId
    || input.database.identity.databaseId !== input.context.databaseId
    || !isDeepStrictEqual(input.context, record.context)
    || migrationResetEvidenceDigest(input.resetProofs ?? []) !== record.resetEvidenceSha256
    || !isDeepStrictEqual(input.handoffs ?? [], record.handoffs)) {
    throw new Error("Remote adoption belongs to different reviewed operation evidence");
  }
}

function receipt(record: MigrationFreezeRecord): RemoteMigrationAdoptionReceipt {
  if (record.phase !== "released" || !record.preconditionSha256 || !record.postconditionSha256) {
    throw new Error("Remote adoption is not complete");
  }
  return { operationId: record.context.operationId, phase: "released",
    preconditionSha256: record.preconditionSha256, postconditionSha256: record.postconditionSha256 };
}

/** Applies only the locally revalidated adoption delta in one guarded D1 transaction. */
export async function executeRemoteInstallationMigrationAdoption(
  input: RemoteMigrationAdoptionInput & { approvedPreconditionSha256: string },
): Promise<RemoteMigrationAdoptionReceipt> {
  let record = await readMigrationFreeze(input.database);
  if (!record) throw new Error("Freeze and review a remote snapshot before applying adoption");
  requireOperation(input, record);
  if (record.phase === "cancelled") throw new Error("Remote adoption was cancelled");
  if (record.preconditionSha256 && record.preconditionSha256 !== input.approvedPreconditionSha256) {
    throw new Error("Approval belongs to a different remote adoption snapshot");
  }
  if (record.phase === "released") return receipt(record);
  if (record.phase === "frozen") {
    const schema = await readMigrationSchema(input.database);
    const snapshot = await captureMigrationSnapshot(input.database, record);
    try {
      const plan = planInstallationMigrationAdoption({ ...input, database: snapshot });
      const legacyId = snapshot.prepare(`PRAGMA table_info(${quote(input.context.legacyLedger)})`).all()
        .find((column) => column.name === "id");
      const idType = String(legacyId?.type).toUpperCase() === "INTEGER" ? "INTEGER" : "TEXT";
      const hasLocalState = Boolean(snapshot.prepare("SELECT name FROM sqlite_schema WHERE name = ?").get(ADOPTION_STATE_TABLE));
      const completed = executeLocalInstallationMigrationAdoption({ ...input, database: snapshot });
      const statements: MigrationD1Statement[] = [assertMigrationFreeze(record, schema),
        writeMigrationFreeze({ ...record, phase: "applying" })];
      for (const owner of plan.owners) {
        if (owner.createLedger) statements.push({ sql: `CREATE TABLE ${quote(owner.ledger)} (
          id ${idType} PRIMARY KEY, name TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )` });
        for (const entry of owner.seed) statements.push({
          sql: `INSERT INTO ${quote(owner.ledger)} (id, name, applied_at) VALUES (?, ?, ?)`,
          params: [entry.id, entry.name, entry.appliedAt],
        });
      }
      for (const reset of plan.resetImports) {
        if (reset.insertReceipt) statements.push({
          sql: "INSERT INTO managed_inference_reset_receipts (operation_id, previous_installation_id, replacement_installation_id, prepared_at) VALUES (?, ?, ?, ?)",
          params: [reset.operationId, reset.previousInstallationId, reset.replacementInstallationId, String(reset.preparedAt)],
        });
        if (reset.insertPreparedParticipant) statements.push({
          sql: "INSERT INTO installation_reset_participants (operation_id, participant_id, state, updated_at) VALUES (?, ?, 'prepared', ?)",
          params: [reset.operationId, reset.participantId, String(reset.preparedAt)],
        });
      }
      if (!hasLocalState) statements.push({ sql: ADOPTION_STATE_SQL });
      statements.push({
        sql: `INSERT INTO ${ADOPTION_STATE_TABLE} (id, record) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET record = excluded.record`,
        params: [JSON.stringify(completed.receipt)],
      });
      const newTables = [...plan.owners.filter((owner) => owner.createLedger).map((owner) => owner.ledger),
        ...(!hasLocalState ? [ADOPTION_STATE_TABLE] : [])];
      statements.push(...newTables.flatMap(freezeTriggers));
      record = { ...record, phase: "adopted", tables: [...record.tables, ...newTables],
        preconditionSha256: input.approvedPreconditionSha256, postconditionSha256: completed.plan.preconditionSha256 };
      statements.push(writeMigrationFreeze(record));
      await input.database.batch(statements);
    } finally { snapshot.close(); }
  }
  // A lost batch response leaves phase=adopted. Verify the preserved snapshot
  // before reopening writes; never infer completion merely from created tables.
  const current = await readMigrationFreeze(input.database);
  if (!current || current.phase !== "adopted") throw new Error("Remote adoption did not retain its verification freeze");
  requireOperation(input, current);
  const schema = await readMigrationSchema(input.database);
  const verified = await captureMigrationSnapshot(input.database, current);
  try {
    const localReceipt = readLocalAdoptionState(verified);
    const plan = planInstallationMigrationAdoption({ ...input, database: verified, handoffs: undefined });
    if (!plan.handoffComplete || plan.resetImports.length > 0
      || plan.preconditionSha256 !== current.postconditionSha256
      || localReceipt?.completedPreconditionSha256 !== current.postconditionSha256) {
      throw new Error("Remote adoption postcondition failed; writes remain frozen");
    }
  } finally { verified.close(); }
  const released: MigrationFreezeRecord = { ...current, phase: "released" };
  await input.database.batch([assertMigrationFreeze(current, schema),
    ...dropFreezeTriggers(current.tables.filter((table) => table !== input.context.legacyLedger)),
    writeMigrationFreeze(released)]);
  const confirmed = await readMigrationFreeze(input.database);
  if (!confirmed) throw new Error("Remote adoption completion receipt is unavailable");
  return receipt(confirmed);
}

/** Reopens writes only when no ownership handoff committed. It preserves all data. */
export async function cancelRemoteInstallationMigrationAdoption(input: RemoteMigrationAdoptionInput): Promise<void> {
  const record = await readMigrationFreeze(input.database);
  if (!record) throw new Error("No remote migration freeze exists");
  requireOperation(input, record);
  if (record.phase === "cancelled") return;
  if (record.phase !== "frozen") throw new Error("A committed ownership handoff cannot be cancelled");
  const schema = await readMigrationSchema(input.database);
  await input.database.batch([assertMigrationFreeze(record, schema), ...dropFreezeTriggers(record.tables),
    writeMigrationFreeze({ ...record, phase: "cancelled" })]);
}
