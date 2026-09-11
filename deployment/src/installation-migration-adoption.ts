import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  installationMigrationInventory,
  type InstallationMigrationOwner,
} from "./installation-migration-inventory.ts";

type Reader = Pick<DatabaseSync, "prepare">;
type Row = Record<string, string | number | bigint | Uint8Array | null>;
type MigrationEntry = { id: string; name: string; appliedAt: string; sha256: string };

export type MigrationAdoptionContext = {
  operationId: string;
  environment: string;
  accountId: string;
  databaseId: string;
  legacyRunnerRevision: string;
  directoryRunnerRevision: string;
  policyRunnerRevision: string;
  legacySourceEvidenceSha256: string;
  legacyRunnerFrozen: boolean;
  legacyLedger: string;
  directoryLedger: "installation_migrations";
  policyLedger: string;
};

export type MigrationOwnerHandoff = {
  operationId: string;
  owner: InstallationMigrationOwner;
  ledger: string;
  evidenceSha256: string;
  state: "seeding" | "complete";
};

export type HistoricalResetProof = {
  operationId: string;
  previousInstallationId: string;
  replacementInstallationId: string;
  kind: "legacy-atomic" | "service-preparation" | "no-services";
  evidenceSha256: string;
  participantId: string;
  preparedAt: number;
};

export type HistoricalResetImport = {
  operationId: string;
  previousInstallationId: string;
  replacementInstallationId: string;
  participantId: string;
  preparedAt: number;
  evidenceSha256: string;
  insertReceipt: boolean;
  insertPreparedParticipant: boolean;
};

export type InstallationMigrationAdoptionPlan = {
  operationId: string;
  evidenceSha256: string;
  preconditionSha256: string;
  owners: {
    owner: InstallationMigrationOwner;
    ledger: string;
    createLedger: boolean;
    beginHandoff: MigrationOwnerHandoff | null;
    seed: MigrationEntry[];
    completeHandoff: MigrationOwnerHandoff | null;
  }[];
  rowCounts: Record<string, number>;
  resetImports: HistoricalResetImport[];
  resetImportsRequireMigrations: string[];
  pendingForwardMigrations: string[];
  handoffComplete: boolean;
};

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const sha256 = (value: string): boolean => /^[a-f0-9]{64}$/.test(value);
const quote = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;
const query = (db: Reader, sql: string, ...bindings: string[]): Row[] => db.prepare(sql).all(...bindings);
const exists = (db: Reader, table: string): boolean => query(db,
  "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?", table).length === 1;

function ledger(db: Reader, name: string): MigrationEntry[] {
  if (!exists(db, name)) return [];
  const columns = query(db, `PRAGMA table_info(${quote(name)})`);
  if (columns.length !== 3 || !["id", "name", "applied_at"].every((column) =>
    columns.some((row) => row.name === column))
    || !columns.some((row) => row.name === "id" && row.pk === 1 && ["TEXT", "INTEGER"].includes(String(row.type).toUpperCase()))
    || !["name", "applied_at"].every((name) => columns.some((row) => row.name === name && row.notnull === 1))) {
    throw new Error("Unrecognized migration ledger schema");
  }
  const seen = new Set<string>();
  return query(db, `SELECT id, name, applied_at FROM ${quote(name)} ORDER BY name`).map((row) => {
    const source = installationMigrationInventory.find((item) => item.name === row.name);
    if (!source || seen.has(source.name) || typeof row.applied_at !== "string" || !Number.isFinite(Date.parse(row.applied_at))
      || !["string", "number"].includes(typeof row.id)) throw new Error("Unrecognized or duplicate applied migration record");
    seen.add(source.name);
    return { id: String(row.id), name: source.name, appliedAt: row.applied_at, sha256: source.sha256 };
  });
}

function schema(db: Reader, excluded: readonly string[]): unknown[] {
  const objects = query(db, "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name")
    .filter((row) => !String(row.name).startsWith("sqlite_") && row.name !== "_cf_KV"
      && !excluded.includes(String(row.tbl_name)));
  return objects.map((object) => ({
    ...object,
    // Tokenize quoted strings separately; whitespace inside a CHECK/default
    // literal is meaningful and must not disappear during schema comparison.
    sql: typeof object.sql === "string"
      ? object.sql.match(/'(?:''|[^'])*'|"(?:""|[^"])*"|[^\s]+/g)?.join(" ")
      : object.sql,
    ...(object.type === "table" ? {
      columns: query(db, `PRAGMA table_xinfo(${quote(String(object.name))})`),
      foreignKeys: query(db, `PRAGMA foreign_key_list(${quote(String(object.name))})`),
      indexes: query(db, `PRAGMA index_list(${quote(String(object.name))})`).map((index) => ({
        ...index,
        columns: query(db, `PRAGMA index_xinfo(${quote(String(index.name))})`),
      })),
    } : {}),
  }));
}

function validateContext(context: MigrationAdoptionContext): void {
  const names = [context.legacyLedger, context.directoryLedger, context.policyLedger];
  if (!context.legacyRunnerFrozen) throw new Error("Freeze the legacy migration runner before adoption");
  if (context.directoryLedger !== "installation_migrations" || new Set(names).size !== 3
    || names.some((name) => !/^[a-z][a-z0-9_]*$/.test(name))) throw new Error("Migration owners require distinct explicit ledger names");
  if (![context.operationId, context.environment, context.accountId, context.databaseId].every((value) => value.trim())) {
    throw new Error("Adoption requires the exact operation, environment, account, and database identity");
  }
  if (![context.legacyRunnerRevision, context.directoryRunnerRevision, context.policyRunnerRevision]
    .every((value) => /^[a-f0-9]{40}$/.test(value)) || !sha256(context.legacySourceEvidenceSha256)) {
    throw new Error("Adoption requires reviewed runner revisions and historical source provenance");
  }
}

/** Reads a snapshot only. Returned actions need the operator's atomic handoff runner. */
export function planInstallationMigrationAdoption(input: {
  database: Reader;
  context: MigrationAdoptionContext;
  sources: readonly { name: string; sql: string }[];
  handoffs: readonly MigrationOwnerHandoff[];
  resetProofs?: readonly HistoricalResetProof[];
}): InstallationMigrationAdoptionPlan {
  const { database: db, context } = input;
  validateContext(context);
  const sourceMap = new Map(input.sources.map((source) => [source.name, source.sql]));
  if (sourceMap.size !== input.sources.length || input.sources.some((source) => {
    const reviewed = installationMigrationInventory.find((item) => item.name === source.name);
    return !reviewed || digest(source.sql) !== reviewed.sha256;
  })) throw new Error("Migration source differs from the reviewed inventory");
  if (!exists(db, context.legacyLedger)) throw new Error("Existing database lacks its legacy migration ledger");
  const applied = ledger(db, context.legacyLedger);
  if (applied.length === 0 || applied.some((entry, index) => entry.name !== installationMigrationInventory[index]?.name)) {
    throw new Error("Legacy ledger is not an applied prefix of the reviewed migration inventory");
  }
  const expected = new DatabaseSync(":memory:");
  let expectedSchema: unknown[];
  try {
    for (const migration of applied) {
      const sql = sourceMap.get(migration.name);
      if (sql === undefined) throw new Error("Applied migration is missing its reviewed source");
      expected.exec(sql);
    }
    expectedSchema = schema(expected, []);
  } finally {
    expected.close();
  }
  const actualSchema = schema(db, [context.legacyLedger, context.directoryLedger, context.policyLedger]);
  if (JSON.stringify(actualSchema) !== JSON.stringify(expectedSchema)) {
    throw new Error("Observed schema disagrees with the applied legacy migrations");
  }
  if (query(db, "PRAGMA foreign_key_check").length !== 0) throw new Error("Database contains broken foreign key references");
  const evidenceSha256 = digest(JSON.stringify({ context, applied, schema: actualSchema }));
  const rowCounts = Object.fromEntries(query(db, "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
    .filter((row) => !String(row.name).startsWith("sqlite_") && row.name !== "_cf_KV"
      && ![context.legacyLedger, context.directoryLedger, context.policyLedger].includes(String(row.name)))
    .map((row) => [String(row.name), Number(query(db, `SELECT COUNT(*) AS count FROM ${quote(String(row.name))}`)[0].count)]));
  if (input.handoffs.length > 2 || new Set(input.handoffs.map((handoff) => handoff.owner)).size !== input.handoffs.length
    || input.handoffs.some((handoff) => !["directory", "policy"].includes(handoff.owner))) {
    throw new Error("Conflicting owner handoff records");
  }
  const owners = (["directory", "policy"] as const).map((owner) => {
    const name = owner === "directory" ? context.directoryLedger : context.policyLedger;
    const handoff = input.handoffs.find((record) => record.owner === owner);
    if (handoff && (handoff.operationId !== context.operationId || handoff.ledger !== name
      || handoff.evidenceSha256 !== evidenceSha256 || !["seeding", "complete"].includes(handoff.state))) {
      throw new Error("Owner handoff belongs to different adoption evidence");
    }
    const verified = applied.filter((entry) => installationMigrationInventory.find((source) => source.name === entry.name)?.owner === owner);
    const present = ledger(db, name);
    if ((!handoff && present.length > 0) || present.some((entry) => !verified.some((record) =>
      JSON.stringify(record) === JSON.stringify(entry)))) throw new Error("Owner ledger contains unverified or conflicting records");
    const seed = verified.filter((entry) => !present.some((record) => record.name === entry.name));
    if (handoff?.state === "complete" && (!exists(db, name) || seed.length > 0)) {
      throw new Error("Completed owner handoff has an incomplete ledger");
    }
    const record = { operationId: context.operationId, owner, ledger: name, evidenceSha256 };
    return { owner, ledger: name, createLedger: !exists(db, name),
      beginHandoff: handoff ? null : { ...record, state: "seeding" as const }, seed,
      completeHandoff: handoff?.state === "complete" ? null : { ...record, state: "complete" as const } };
  });
  const hasResets = (rowCounts.installation_reset_operations ?? 0) > 0;
  if (hasResets && query(db, `SELECT r.operation_id FROM installation_reset_operations r
    LEFT JOIN installations p ON p.id = r.previous_installation_id
    LEFT JOIN installations n ON n.id = r.replacement_installation_id
    WHERE p.id IS NULL OR n.id IS NULL`).length > 0) {
    throw new Error("Reset references a missing installation");
  }
  const resetImportsRequireMigrations = hasResets ? installationMigrationInventory.slice(10)
    .filter((migration) => !applied.some((record) => record.name === migration.name)).map((migration) => migration.name) : [];
  const resetImports = (hasResets || (rowCounts.managed_inference_reset_receipts ?? 0) > 0) && resetImportsRequireMigrations.length === 0
    ? historicalResetImports(db, input.resetProofs ?? []) : [];
  const handoffComplete = owners.every((owner) => owner.completeHandoff === null);
  return { operationId: context.operationId, evidenceSha256,
    preconditionSha256: digest(JSON.stringify({ evidenceSha256, rowCounts, owners, resetImports })),
    owners, rowCounts, resetImports, resetImportsRequireMigrations, handoffComplete,
    pendingForwardMigrations: installationMigrationInventory.filter((source) => !applied.some((entry) => entry.name === source.name))
      .map((source) => source.name) };
}

function historicalResetImports(db: Reader, proofs: readonly HistoricalResetProof[]): HistoricalResetImport[] {
  const resets = query(db, `SELECT r.*, p.state AS previous_state, n.state AS replacement_state,
    policy.enabled AS previous_policy_enabled
    FROM installation_reset_operations r
    LEFT JOIN installations p ON p.id = r.previous_installation_id
    LEFT JOIN installations n ON n.id = r.replacement_installation_id
    LEFT JOIN managed_inference_policies policy ON policy.installation_id = r.previous_installation_id
    ORDER BY r.operation_id`);
  if (new Set(proofs.map((proof) => proof.operationId)).size !== proofs.length
    || proofs.some((proof) => !resets.some((reset) => reset.operation_id === proof.operationId))) {
    throw new Error("Historical reset provenance does not match the reset inventory");
  }
  const receipts = query(db, "SELECT * FROM managed_inference_reset_receipts ORDER BY operation_id");
  if (receipts.some((receipt) => !resets.some((reset) => reset.operation_id === receipt.operation_id
    && reset.previous_installation_id === receipt.previous_installation_id
    && reset.replacement_installation_id === receipt.replacement_installation_id))) {
    throw new Error("Reset receipt identity disagrees with directory state");
  }
  return resets.flatMap((reset) => {
    if (!reset.previous_state || !reset.replacement_state) throw new Error("Reset references a missing installation");
    if (!["retained", "deleting", "deleted"].includes(String(reset.previous_state))) {
      throw new Error("Reset previous identity is not retired");
    }
    const participants = query(db, "SELECT * FROM installation_reset_participants WHERE operation_id = ? ORDER BY participant_id", String(reset.operation_id));
    const receipt = receipts.find((row) => row.operation_id === reset.operation_id);
    const proof = proofs.find((row) => row.operationId === reset.operation_id);
    if (!proof || proof.previousInstallationId !== reset.previous_installation_id
      || proof.replacementInstallationId !== reset.replacement_installation_id || !sha256(proof.evidenceSha256)
      || !proof.participantId.trim() || !Number.isSafeInteger(proof.preparedAt) || proof.preparedAt < 0) {
      throw new Error("Each historical reset requires explicit operation-bound provenance");
    }
    if (participants.some((participant) => participant.state === "pending")
      && reset.replacement_state !== "reserved") throw new Error("Unprepared reset replacement is already routable");
    if (proof.kind === "service-preparation") {
      if (!participants.some((participant) => participant.participant_id === proof.participantId)
        || (participants.some((participant) => participant.participant_id === proof.participantId && participant.state === "prepared") && !receipt)) {
        throw new Error("Service preparation is missing its frozen participant or durable receipt");
      }
      return [];
    }
    if (proof.kind === "no-services") {
      if (participants.length !== 0 || receipt || reset.previous_policy_enabled !== null) {
        throw new Error("Reset state disagrees with no-service provenance");
      }
      return [];
    }
    if (proof.kind !== "legacy-atomic" || !["retained", "deleting", "deleted"].includes(String(reset.previous_state))
      || (reset.previous_policy_enabled !== null && reset.previous_policy_enabled !== 0)
      || participants.some((participant) => participant.participant_id !== proof.participantId || participant.state !== "prepared")) {
      throw new Error("Reset state disagrees with verified legacy atomic preparation");
    }
    if (receipt && participants.length > 0) return [];
    return [{ operationId: proof.operationId, previousInstallationId: proof.previousInstallationId,
      replacementInstallationId: proof.replacementInstallationId, participantId: proof.participantId,
      preparedAt: receipt ? Number(receipt.prepared_at) : proof.preparedAt,
      evidenceSha256: proof.evidenceSha256,
      insertReceipt: !receipt, insertPreparedParticipant: participants.length === 0 }];
  });
}
