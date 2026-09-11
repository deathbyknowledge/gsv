import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  planInstallationMigrationAdoption,
  type HistoricalResetProof,
  type MigrationAdoptionContext,
  type MigrationOwnerHandoff,
} from "../src/installation-migration-adoption.ts";
import { executeLocalInstallationMigrationAdoption } from "@humansandmachines/gsv-deployment/installation-migration-adoption-local";
import { ADOPTION_STATE_TABLE, readLocalAdoptionState } from "../src/installation-migration-adoption-state.ts";
import { installationMigrationInventory } from "../src/installation-migration-inventory.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const databases = new Set<DatabaseSync>();
const directories: string[] = [];
afterEach(() => {
  for (const db of databases) db.close();
  databases.clear();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});
const context: MigrationAdoptionContext = {
  operationId: "local-adoption", environment: "fixture", accountId: "account", databaseId: "database",
  legacyRunnerRevision: "a".repeat(40), directoryRunnerRevision: "b".repeat(40), policyRunnerRevision: "c".repeat(40),
  legacySourceEvidenceSha256: "d".repeat(64), legacyRunnerFrozen: true,
  legacyLedger: "d1_migrations", directoryLedger: "installation_migrations", policyLedger: "inference_migrations",
};

function sourceFiles(directory: string, count: number) {
  return installationMigrationInventory.slice(0, count).map(({ name }) => ({
    name, sql: readFileSync(path.join(directory, name), "utf8"),
  }));
}

function fixture(sources = sourceFiles(path.join(root, "workers/installations/migrations"), 2), file = ":memory:") {
  const database = new DatabaseSync(file);
  databases.add(database);
  database.exec("CREATE TABLE d1_migrations (id TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  for (const [index, source] of sources.entries()) {
    database.exec(source.sql);
    database.prepare("INSERT INTO d1_migrations VALUES (?, ?, ?)")
      .run(String(index + 1).padStart(5, "0"), source.name, "2026-09-01 00:00:00");
  }
  database.exec("INSERT INTO principals VALUES ('principal', 'owner@example.invalid', 'owner@example.invalid', 'Owner', 1, 'active', 1, 1)");
  const handoffs: MigrationOwnerHandoff[] = [];
  const resetProofs: HistoricalResetProof[] = [];
  const input = { database, context, sources, handoffs, resetProofs };
  return { database, input };
}

function approve(state: ReturnType<typeof fixture>) {
  return { ...state.input, approvedPreconditionSha256: planInstallationMigrationAdoption(state.input).preconditionSha256 };
}

function principal(database: DatabaseSync) {
  return database.prepare("SELECT * FROM principals").all();
}

describe("transactional local migration adoption", () => {
  it("copies only verified ledger entries and preserves legacy evidence and existing data", () => {
    const state = fixture();
    const legacy = state.database.prepare("SELECT * FROM d1_migrations ORDER BY id").all();
    const owners = principal(state.database);
    const result = executeLocalInstallationMigrationAdoption(approve(state));
    expect(result.applied).toBe(true);
    expect(result.plan.handoffComplete).toBe(true);
    expect(result.plan.pendingForwardMigrations).toHaveLength(10);
    expect(result.receipt.handoffs.map((owner) => owner.state)).toEqual(["complete", "complete"]);
    expect(state.database.prepare("SELECT * FROM installation_migrations ORDER BY id").all()).toEqual(legacy);
    expect(state.database.prepare("SELECT * FROM inference_migrations").all()).toEqual([]);
    expect(state.database.prepare("SELECT * FROM d1_migrations ORDER BY id").all()).toEqual(legacy);
    expect(principal(state.database)).toEqual(owners);
    expect(readLocalAdoptionState(state.database)).toEqual(result.receipt);
  });

  it("rejects a same-count edit after approval before creating either ledger", () => {
    const state = fixture();
    const input = approve(state);
    state.database.exec("UPDATE principals SET display_name = 'Changed after review'");
    expect(() => executeLocalInstallationMigrationAdoption(input)).toThrow(/precondition changed/);
    expect(readLocalAdoptionState(state.database)).toBeNull();
    expect(state.database.prepare("SELECT name FROM sqlite_schema WHERE name = 'installation_migrations'").all()).toEqual([]);
    expect(state.database.isTransaction).toBe(false);
  });

  it("rolls back earlier ledger inserts and handoff records when a later insert fails", () => {
    const state = fixture();
    state.database.exec(`CREATE TABLE installation_migrations (
      id TEXT PRIMARY KEY, name TEXT NOT NULL CHECK (name = '0001_account_directory.sql'), applied_at TEXT NOT NULL
    )`);
    const before = principal(state.database);
    expect(() => executeLocalInstallationMigrationAdoption(approve(state))).toThrow(/CHECK constraint/);
    expect(state.database.prepare("SELECT * FROM installation_migrations").all()).toEqual([]);
    expect(state.database.prepare("SELECT name FROM sqlite_schema WHERE name = ?").get(ADOPTION_STATE_TABLE)).toBeUndefined();
    expect(principal(state.database)).toEqual(before);
    expect(state.database.isTransaction).toBe(false);
  });

  it.each([1, 2])("resumes reviewed legacy handoff interrupted after %i directory records", (count) => {
    const state = fixture();
    const first = planInstallationMigrationAdoption(state.input);
    const owner = first.owners[0];
    if (!owner.beginHandoff || !owner.completeHandoff) throw new Error("Expected an initial handoff");
    state.database.exec("CREATE TABLE installation_migrations (id TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
    for (const record of owner.seed.slice(0, count)) {
      state.database.prepare("INSERT INTO installation_migrations VALUES (?, ?, ?)").run(record.id, record.name, record.appliedAt);
    }
    state.input.handoffs.push(count === 2 ? owner.completeHandoff : owner.beginHandoff);
    const input = approve(state);
    const result = executeLocalInstallationMigrationAdoption(input);
    expect(result.plan.handoffComplete).toBe(true);
    expect(state.database.prepare("SELECT COUNT(*) AS count FROM installation_migrations").get()).toEqual({ count: 2 });
    expect(executeLocalInstallationMigrationAdoption(input).applied).toBe(false);
  });

  it("recovers a committed result after close/reopen with the original approval", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "gsv-adoption-"));
    directories.push(directory);
    const file = path.join(directory, "snapshot.sqlite");
    const state = fixture(undefined, file);
    const input = approve(state);
    const first = executeLocalInstallationMigrationAdoption(input);
    state.database.close();
    databases.delete(state.database);
    const database = new DatabaseSync(file);
    databases.add(database);
    const replay = executeLocalInstallationMigrationAdoption({ ...input, database });
    expect(replay.applied).toBe(false);
    expect(replay.receipt).toEqual(first.receipt);
    database.exec("UPDATE principals SET display_name = 'Later write'");
    expect(() => executeLocalInstallationMigrationAdoption({ ...input, database })).toThrow(/verified postcondition/);
  });

  it("preserves Wrangler integer IDs and leaves owner ledgers usable for future inserts", () => {
    const state = fixture();
    state.database.exec(`ALTER TABLE d1_migrations RENAME TO former;
      CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);
      INSERT INTO d1_migrations SELECT * FROM former; DROP TABLE former;`);
    const before = state.database.prepare("SELECT * FROM d1_migrations ORDER BY id").all();
    executeLocalInstallationMigrationAdoption(approve(state));
    expect(state.database.prepare("SELECT * FROM installation_migrations ORDER BY id").all()).toEqual(before);
    // This emulates the owning runner's ledger write, not execution of forward DDL.
    state.database.prepare("INSERT INTO installation_migrations (name) VALUES (?)").run("future.sql");
    expect(state.database.prepare("SELECT id FROM installation_migrations WHERE name = 'future.sql'").get()).toEqual({ id: 3 });
  });

  it("resumes an existing Wrangler ledger while preserving the legacy sequence", () => {
    const state = fixture();
    state.database.exec(`ALTER TABLE d1_migrations RENAME TO former;
      CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);
      INSERT INTO d1_migrations SELECT * FROM former; DROP TABLE former;
      CREATE TABLE installation_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);`);
    const initial = planInstallationMigrationAdoption(state.input);
    const owner = initial.owners[0];
    if (!owner.beginHandoff) throw new Error("Expected an initial handoff");
    state.input.handoffs.push(owner.beginHandoff);
    state.database.exec("INSERT INTO installation_migrations SELECT * FROM d1_migrations WHERE id = 1");
    const input = approve(state);
    expect(executeLocalInstallationMigrationAdoption(input).plan.handoffComplete).toBe(true);
    expect(state.database.prepare("SELECT * FROM sqlite_sequence ORDER BY name").all()).toEqual([
      { name: "d1_migrations", seq: 2 }, { name: "installation_migrations", seq: 2 },
    ]);
    expect(executeLocalInstallationMigrationAdoption(input).applied).toBe(false);
  });

  it("rejects a forged metadata schema or migration-ledger trigger", () => {
    const forged = fixture();
    forged.database.exec(`CREATE TABLE ${ADOPTION_STATE_TABLE} (id INTEGER PRIMARY KEY, record TEXT)`);
    expect(() => approve(forged)).toThrow(/metadata schema/);
    const state = fixture();
    state.database.exec(`CREATE TABLE installation_migrations (id TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
      CREATE TRIGGER alter_owner AFTER INSERT ON installation_migrations
      BEGIN UPDATE principals SET display_name = 'Unreviewed trigger'; END;`);
    expect(() => executeLocalInstallationMigrationAdoption(approve(state))).toThrow(/must not trigger/);
    expect(principal(state.database)[0].display_name).toBe("Owner");
  });

  it("does not commit an enclosing transaction or disable foreign keys", () => {
    const state = fixture();
    const input = approve(state);
    state.database.exec("BEGIN; UPDATE principals SET display_name = 'Caller transaction'");
    expect(() => executeLocalInstallationMigrationAdoption(input)).toThrow(/own its transaction/);
    expect(state.database.isTransaction).toBe(true);
    state.database.exec("ROLLBACK; PRAGMA foreign_keys = OFF");
    expect(() => executeLocalInstallationMigrationAdoption(input)).toThrow(/foreign key enforcement/);
    expect(principal(state.database)[0].display_name).toBe("Owner");
  });
});

const privateMigrations = process.env.GSV_ADOPTION_LEGACY_MIGRATIONS;
describe.skipIf(!privateMigrations)("local adoption with private migration sources", () => {
  function complete(count = 12) { return fixture(sourceFiles(privateMigrations!, count)); }

  function addReset(state: ReturnType<typeof complete>) {
    const db = state.database;
    for (const [id, status] of [["previous", "retained"], ["replacement", "active"]]) {
      db.prepare("INSERT INTO installations (id, owner_principal_id, handle, canonical_origin, state, provision_version, created_at) VALUES (?, 'principal', ?, ?, ?, 1, 1)")
        .run(id, id, `https://${id}.example.invalid`, status);
    }
    db.exec(`INSERT INTO installation_reset_operations VALUES ('reset', 'previous', 'replacement', 'ship',
      'https://ship.example.invalid', 'ship.example.invalid', 'pending', NULL, 1, 2, NULL);
      INSERT INTO managed_inference_policies VALUES ('previous', 0, 100, 2);
      INSERT INTO managed_inference_policies VALUES ('replacement', 1, 900, 99);`);
    state.input.resetProofs.push({ operationId: "reset", previousInstallationId: "previous", replacementInstallationId: "replacement",
      kind: "legacy-atomic", evidenceSha256: "e".repeat(64), participantId: "inference", preparedAt: 1 });
  }

  it.each([9, 10, 11, 12])("adopts prefix %i without replaying routing seeds or changing usage/policy state", (count) => {
    const state = complete(count);
    const routing = state.database.prepare("SELECT * FROM managed_inference_routing").all();
    const result = executeLocalInstallationMigrationAdoption(approve(state));
    expect(result.plan.handoffComplete).toBe(true);
    expect(state.database.prepare("SELECT * FROM managed_inference_routing").all()).toEqual(routing);
    expect(Number(state.database.prepare("SELECT COUNT(*) AS count FROM installation_migrations").get()?.count)
      + Number(state.database.prepare("SELECT COUNT(*) AS count FROM inference_migrations").get()?.count)).toBe(count);
  });

  it.each([false, true])("imports historical prepared evidence once, including a lost receipt reply (%s)", (receiptExists) => {
    const state = complete();
    addReset(state);
    const policies = state.database.prepare("SELECT * FROM managed_inference_policies ORDER BY installation_id").all();
    const resets = state.database.prepare("SELECT * FROM installation_reset_operations").all();
    if (receiptExists) state.database.exec("INSERT INTO managed_inference_reset_receipts VALUES ('reset', 'previous', 'replacement', 7)");
    const input = approve(state);
    executeLocalInstallationMigrationAdoption(input);
    expect(state.database.prepare("SELECT * FROM installation_reset_participants").all()).toEqual([
      { operation_id: "reset", participant_id: "inference", state: "prepared", updated_at: receiptExists ? 7 : 1 },
    ]);
    expect(state.database.prepare("SELECT * FROM managed_inference_policies ORDER BY installation_id").all()).toEqual(policies);
    expect(state.database.prepare("SELECT * FROM installation_reset_operations").all()).toEqual(resets);
    expect(executeLocalInstallationMigrationAdoption(input).applied).toBe(false);
  });

  it("rejects changed reset proof evidence and forged receipt identities", () => {
    const state = complete();
    addReset(state);
    const input = approve(state);
    state.input.resetProofs[0].preparedAt = 99;
    expect(() => executeLocalInstallationMigrationAdoption(input)).toThrow(/precondition changed/);
    state.input.resetProofs[0].preparedAt = 1;
    state.database.exec("INSERT INTO managed_inference_reset_receipts VALUES ('reset', 'replacement', 'previous', 1)");
    expect(() => executeLocalInstallationMigrationAdoption(input)).toThrow(/receipt identity disagrees/);
    expect(readLocalAdoptionState(state.database)).toBeNull();
  });

  it("leaves genuine service preparation pending and refuses missing historical import tables", () => {
    const state = complete();
    addReset(state);
    state.database.exec(`UPDATE installations SET state = 'reserved' WHERE id = 'replacement';
      INSERT INTO installation_reset_participants VALUES ('reset', 'inference', 'pending', 8)`);
    state.input.resetProofs[0].kind = "service-preparation";
    executeLocalInstallationMigrationAdoption(approve(state));
    expect(state.database.prepare("SELECT state, updated_at FROM installation_reset_participants").all()).toEqual([{ state: "pending", updated_at: 8 }]);
    expect(state.database.prepare("SELECT * FROM managed_inference_reset_receipts").all()).toEqual([]);
    const legacy = complete(9);
    addReset(legacy);
    expect(() => executeLocalInstallationMigrationAdoption(approve(legacy))).toThrow(/preparation migrations before/);
    expect(readLocalAdoptionState(legacy.database)).toBeNull();
  });
});
