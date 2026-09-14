import type { DatabaseSync } from "node:sqlite";
import {
  planInstallationMigrationAdoption,
  type InstallationMigrationAdoptionPlan,
} from "./installation-migration-adoption.ts";
import {
  ADOPTION_STATE_SQL,
  ADOPTION_STATE_TABLE,
  adoptionDigest,
  adoptionRowsDigest,
  quoteAdoptionIdentifier,
  readLocalAdoptionState,
  type LocalAdoptionState,
} from "./installation-migration-adoption-state.ts";

type PlannerInput = Parameters<typeof planInstallationMigrationAdoption>[0];
export type LocalMigrationAdoptionInput = Omit<PlannerInput, "database"> & {
  database: DatabaseSync;
  approvedPreconditionSha256: string;
};
export type LocalMigrationAdoptionResult = {
  applied: boolean;
  receipt: LocalAdoptionState;
  plan: InstallationMigrationAdoptionPlan;
};

/** Applies one approved local snapshot. This does not freeze or mutate remote D1. */
export function executeLocalInstallationMigrationAdoption(
  input: LocalMigrationAdoptionInput,
): LocalMigrationAdoptionResult {
  const db = input.database;
  if (db.isTransaction) throw new Error("Local adoption must own its transaction");
  if (db.prepare("PRAGMA foreign_keys").get()?.foreign_keys !== 1) {
    throw new Error("Local adoption requires foreign key enforcement");
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const persisted = readLocalAdoptionState(db);
    const planning = {
      database: db, context: input.context, sources: input.sources,
      resetProofs: input.resetProofs, handoffs: persisted ? undefined : input.handoffs,
    };
    const plan = planInstallationMigrationAdoption(planning);
    const resetProofsSha256 = adoptionDigest(JSON.stringify(input.resetProofs ?? []));
    if (persisted && persisted.resetProofsSha256 !== resetProofsSha256) {
      throw new Error("Local adoption reset evidence has changed");
    }
    if (persisted?.completedPreconditionSha256) {
      if (![persisted.approvedPreconditionSha256, persisted.completedPreconditionSha256]
        .includes(input.approvedPreconditionSha256)
        || plan.preconditionSha256 !== persisted.completedPreconditionSha256
        || !plan.handoffComplete || plan.resetImports.length !== 0) {
        throw new Error("Completed local adoption no longer matches its verified postcondition");
      }
      db.exec("COMMIT");
      return { applied: false, receipt: persisted, plan };
    }
    if (plan.preconditionSha256 !== input.approvedPreconditionSha256) {
      throw new Error("Local adoption precondition changed; review a fresh snapshot");
    }
    if (plan.resetImportsRequireMigrations.length !== 0) {
      throw new Error("Apply reviewed reset preparation migrations before local adoption");
    }
    const ledgers = [input.context.legacyLedger, ...plan.owners.map((owner) => owner.ledger)];
    for (const ledger of ledgers) {
      if (db.prepare("SELECT name FROM sqlite_schema WHERE tbl_name = ? AND type = 'trigger'").get(ledger)
        || db.prepare(`PRAGMA foreign_key_list(${quoteAdoptionIdentifier(ledger)})`).all().length !== 0) {
        throw new Error("Migration ledgers must not trigger changes to application data");
      }
    }
    const preservedTables = plan.owners.map((owner) => owner.ledger);
    // Existing Wrangler ledgers may use AUTOINCREMENT. Only their own sequence
    // rows may advance; the legacy ledger's sequence remains historical evidence.
    const ownerSequences = preservedTables.map((name) => ({ table: "sqlite_sequence", key: { name } }));
    const preservedRowsSha256 = adoptionRowsDigest(db, preservedTables, ownerSequences);
    const state: LocalAdoptionState = {
      format: 1, operationId: plan.operationId, evidenceSha256: plan.evidenceSha256,
      approvedPreconditionSha256: input.approvedPreconditionSha256,
      completedPreconditionSha256: null, resetProofsSha256,
      handoffs: plan.owners.map((owner) => ({
        operationId: plan.operationId, owner: owner.owner, ledger: owner.ledger,
        evidenceSha256: plan.evidenceSha256,
        state: owner.completeHandoff === null ? "complete" : "seeding",
      })),
    };
    if (!db.prepare("SELECT name FROM sqlite_schema WHERE name = ?").get(ADOPTION_STATE_TABLE)) {
      db.exec(ADOPTION_STATE_SQL);
    }
    const saveState = () => db.prepare(`INSERT INTO ${ADOPTION_STATE_TABLE} (id, record) VALUES (1, ?)
      ON CONFLICT(id) DO UPDATE SET record = excluded.record`).run(JSON.stringify(state));
    saveState();
    // The durable local record owns handoffs after this point, including on retry.
    planning.handoffs = undefined;
    const legacyId = db.prepare(`PRAGMA table_info(${quoteAdoptionIdentifier(input.context.legacyLedger)})`)
      .all().find((column) => column.name === "id");
    const idType = String(legacyId?.type).toUpperCase() === "INTEGER" ? "INTEGER" : "TEXT";
    for (const [index, owner] of plan.owners.entries()) {
      const ledger = quoteAdoptionIdentifier(owner.ledger);
      if (owner.createLedger) {
        db.exec(`CREATE TABLE ${ledger} (
          id ${idType} PRIMARY KEY, name TEXT NOT NULL UNIQUE,
          applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);
      }
      const insert = db.prepare(`INSERT INTO ${ledger} (id, name, applied_at) VALUES (?, ?, ?)`);
      for (const entry of owner.seed) insert.run(entry.id, entry.name, entry.appliedAt);
      const verified = planInstallationMigrationAdoption(planning).owners[index];
      if (verified.seed.length !== 0) throw new Error("Owner migration ledger is incomplete");
      state.handoffs[index].state = "complete";
      saveState();
    }
    const insertedRows: { table: string; key: Record<string, string> }[] = [];
    for (const reset of plan.resetImports) {
      if (reset.insertReceipt) {
        db.prepare(`INSERT INTO managed_inference_reset_receipts
          (operation_id, previous_installation_id, replacement_installation_id, prepared_at)
          VALUES (?, ?, ?, ?)`)
          .run(reset.operationId, reset.previousInstallationId, reset.replacementInstallationId, reset.preparedAt);
        insertedRows.push({ table: "managed_inference_reset_receipts", key: { operation_id: reset.operationId } });
      }
      if (reset.insertPreparedParticipant) {
        db.prepare(`INSERT INTO installation_reset_participants (operation_id, participant_id, state, updated_at)
          VALUES (?, ?, 'prepared', ?)`)
          .run(reset.operationId, reset.participantId, reset.preparedAt);
        insertedRows.push({ table: "installation_reset_participants", key: {
          operation_id: reset.operationId, participant_id: reset.participantId,
        } });
      }
    }
    if (adoptionRowsDigest(db, preservedTables, [...ownerSequences, ...insertedRows]) !== preservedRowsSha256) {
      throw new Error("Local adoption changed existing application data or legacy evidence");
    }
    const complete = planInstallationMigrationAdoption(planning);
    if (!complete.handoffComplete || complete.resetImports.length !== 0) {
      throw new Error("Local adoption did not reach its verified postcondition");
    }
    state.completedPreconditionSha256 = complete.preconditionSha256;
    saveState();
    db.exec("COMMIT");
    return { applied: true, receipt: state, plan: complete };
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
