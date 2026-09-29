import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  planInstallationMigrationAdoption,
  type HistoricalResetProof,
  type InstallationMigrationAdoptionPlan,
  type MigrationAdoptionContext,
  type MigrationOwnerHandoff,
} from "../src/installation-migration-adoption.ts";
import { installationMigrationInventory } from "../src/installation-migration-inventory.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const context: MigrationAdoptionContext = {
  operationId: "adoption-1", environment: "fixture", accountId: "account-1", databaseId: "database-1",
  legacyRunnerRevision: "a".repeat(40), directoryRunnerRevision: "b".repeat(40), policyRunnerRevision: "c".repeat(40),
  legacySourceEvidenceSha256: "d".repeat(64), legacyRunnerFrozen: true,
  legacyLedger: "d1_migrations", directoryLedger: "installation_migrations", policyLedger: "inference_migrations",
};

function sourceFiles(directory: string, count: number) {
  return installationMigrationInventory.slice(0, count).map(({ name }) => ({
    name, sql: readFileSync(path.join(directory, name), "utf8"),
  }));
}

function fixture(sources = sourceFiles(path.join(root, "workers/installations/migrations"), 2)) {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("CREATE TABLE d1_migrations (id TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  for (const [index, source] of sources.entries()) {
    database.exec(source.sql);
    database.prepare("INSERT INTO d1_migrations VALUES (?, ?, ?)").run(String(index + 1).padStart(5, "0"), source.name, `2026-09-01 00:00:${String(index).padStart(2, "0")}`);
  }
  const handoffs: MigrationOwnerHandoff[] = [];
  const resetProofs: HistoricalResetProof[] = [];
  const input = { database, context, sources, handoffs, resetProofs };
  return { database, input };
}

function applyOwner(state: ReturnType<typeof fixture>, plan: InstallationMigrationAdoptionPlan, index: number, limit = Infinity) {
  const owner = plan.owners[index];
  if (owner.beginHandoff) state.input.handoffs.push(owner.beginHandoff);
  if (owner.createLedger) state.database.exec(`CREATE TABLE ${owner.ledger} (id TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  for (const entry of owner.seed.slice(0, limit)) {
    state.database.prepare(`INSERT INTO ${owner.ledger} VALUES (?, ?, ?)`).run(entry.id, entry.name, entry.appliedAt);
  }
  if (limit >= owner.seed.length && owner.completeHandoff) {
    const current = state.input.handoffs.findIndex((record) => record.owner === owner.owner);
    state.input.handoffs[current] = owner.completeHandoff;
  }
}

describe("installation migration adoption", () => {
  it("pins the exact twelve-file owner inventory and unchanged public migration sources", () => {
    expect(installationMigrationInventory.filter((source) => source.owner === "directory").map((source) => source.name.slice(0, 4))).toEqual(["0001", "0002", "0006", "0010", "0011"]);
    expect(installationMigrationInventory.filter((source) => source.owner === "policy").map((source) => source.name.slice(0, 4))).toEqual(["0003", "0004", "0005", "0007", "0008", "0009", "0012"]);
    for (const source of installationMigrationInventory.filter((source) => source.owner === "directory")) {
      const bytes = readFileSync(path.join(root, "workers/installations/migrations", source.name));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(source.sha256);
    }
  });

  it("seeds only verified applied records and recovers interruption within and between owners", () => {
    const state = fixture();
    const first = planInstallationMigrationAdoption(state.input);
    const legacyBefore = state.database.prepare("SELECT * FROM d1_migrations ORDER BY id").all();
    expect(first.handoffComplete).toBe(false);
    expect(first.owners[0].seed.map((record) => record.name)).toHaveLength(2);
    expect(first.owners[1].seed).toEqual([]);
    applyOwner(state, first, 0, 1);
    const partial = planInstallationMigrationAdoption(state.input);
    expect(partial.owners[0].beginHandoff).toBeNull();
    expect(partial.owners[0].seed.map((record) => record.name)).toEqual(["0002_installation_onboarding.sql"]);
    applyOwner(state, partial, 0);
    const between = planInstallationMigrationAdoption(state.input);
    expect(between.handoffComplete).toBe(false);
    expect(between.owners[0].seed).toEqual([]);
    expect(between.owners[0].completeHandoff).toBeNull();
    applyOwner(state, between, 1);
    const done = planInstallationMigrationAdoption(state.input);
    expect(done.handoffComplete).toBe(true);
    expect(done.pendingForwardMigrations).toHaveLength(10);
    expect(done.owners.every((owner) => owner.seed.length === 0 && owner.completeHandoff === null)).toBe(true);
    expect(state.database.prepare("SELECT * FROM d1_migrations ORDER BY id").all()).toEqual(legacyBefore);
  });

  it("does not infer handoff completion from an existing or populated owner ledger", () => {
    const state = fixture();
    state.database.exec("CREATE TABLE installation_migrations (id TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
    const empty = planInstallationMigrationAdoption(state.input);
    expect(empty.owners[0].createLedger).toBe(false);
    expect(empty.owners[0].seed).toHaveLength(2);
    state.database.exec("INSERT INTO installation_migrations SELECT * FROM d1_migrations");
    expect(() => planInstallationMigrationAdoption(state.input)).toThrow(/unverified/);
  });

  it("adopts Wrangler's standard ledger while rejecting null migration names", () => {
    const state = fixture();
    state.database.exec(`ALTER TABLE d1_migrations RENAME TO previous_ledger;
      CREATE TABLE d1_migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
      );
      INSERT INTO d1_migrations SELECT * FROM previous_ledger;
      DROP TABLE previous_ledger;`);
    const before = state.database.prepare("SELECT * FROM d1_migrations ORDER BY id").all();
    const plan = planInstallationMigrationAdoption(state.input);
    expect(plan.owners[0].seed.map((entry) => entry.id)).toEqual(["1", "2"]);
    applyOwner(state, plan, 0);
    expect(planInstallationMigrationAdoption(state.input).owners[0].seed).toEqual([]);
    expect(state.database.prepare("SELECT * FROM d1_migrations ORDER BY id").all()).toEqual(before);
    state.database.exec("INSERT INTO d1_migrations (name) VALUES (NULL)");
    expect(() => planInstallationMigrationAdoption(state.input)).toThrow(/record shape/);
  });

  it("rejects changed provenance, conflicting timestamps, and falsely completed handoffs", () => {
    const state = fixture();
    const first = planInstallationMigrationAdoption(state.input);
    applyOwner(state, first, 0, 1);
    expect(() => planInstallationMigrationAdoption({ ...state.input, context: { ...context, databaseId: "another" } })).toThrow(/different adoption evidence/);
    state.database.exec("UPDATE installation_migrations SET applied_at = '2026-09-09'");
    expect(() => planInstallationMigrationAdoption(state.input)).toThrow(/conflicting records/);
    state.database.exec("DELETE FROM installation_migrations");
    state.input.handoffs[0].state = "complete";
    expect(() => planInstallationMigrationAdoption(state.input)).toThrow(/incomplete ledger/);
  });

  it("fails closed on unclassified migrations, source drift, schema drift, and unfrozen runners", () => {
    const state = fixture();
    expect(() => planInstallationMigrationAdoption({ ...state.input, context: { ...context, legacyRunnerFrozen: false } })).toThrow(/Freeze/);
    expect(() => planInstallationMigrationAdoption({ ...state.input, sources: [{ ...state.input.sources[0], sql: "SELECT 1" }] })).toThrow(/source differs/);
    expect(() => planInstallationMigrationAdoption({ ...state.input, context: { ...context, policyLedger: "installation_migrations" } })).toThrow(/distinct/);
    state.database.exec("INSERT INTO d1_migrations VALUES ('99999', '0013_unknown.sql', '2026-09-11')");
    expect(() => planInstallationMigrationAdoption(state.input)).toThrow(/Unrecognized/);
    state.database.exec("DELETE FROM d1_migrations WHERE id = '99999'");
    state.database.exec("CREATE INDEX unexpected_index ON principals(state)");
    expect(() => planInstallationMigrationAdoption(state.input)).toThrow(/schema disagrees/);
  });

  it("runs against a query-only snapshot and rejects a migration assigned to the wrong owner", () => {
    const state = fixture();
    state.database.exec("PRAGMA query_only = ON");
    expect(() => planInstallationMigrationAdoption(state.input)).not.toThrow();
    state.database.exec("PRAGMA query_only = OFF");
    const plan = planInstallationMigrationAdoption(state.input);
    applyOwner(state, plan, 1);
    state.database.exec("INSERT INTO inference_migrations SELECT * FROM d1_migrations");
    expect(() => planInstallationMigrationAdoption(state.input)).toThrow(/unverified or conflicting/);
  });
});

// The public suite must not vendor private SQL or commercial seeds. The private
// owner and the deployment acceptance job supply their reviewed source directory.
const privateMigrations = process.env.GSV_ADOPTION_LEGACY_MIGRATIONS;
describe.skipIf(!privateMigrations)("complete legacy D1 schema (private source acceptance)", () => {
  function complete(count = 12) { return fixture(sourceFiles(privateMigrations!, count)); }

  function reset(state: ReturnType<typeof complete>, replacementState: string, suffix = "1") {
    const { database: db } = state;
    db.prepare("INSERT OR IGNORE INTO principals VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("principal", "owner@example.invalid", "owner@example.invalid", "Owner", 1, "active", 1, 1);
    for (const [id, status] of [[`previous-${suffix}`, "retained"], [`replacement-${suffix}`, replacementState]]) {
      db.prepare("INSERT INTO installations (id, owner_principal_id, handle, canonical_origin, state, provision_version, created_at) VALUES (?, 'principal', ?, ?, ?, 1, 1)")
        .run(id, id, `https://${id}.example.invalid`, status);
    }
    db.prepare("INSERT INTO installation_reset_operations VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, 1, 2, NULL)")
      .run(`reset-${suffix}`, `previous-${suffix}`, `replacement-${suffix}`, `ship-${suffix}`, `https://ship-${suffix}.example.invalid`, `ship-${suffix}.example.invalid`);
    db.prepare("INSERT INTO managed_inference_policies VALUES (?, 0, 100, 2)").run(`previous-${suffix}`);
    db.prepare("INSERT INTO managed_inference_policies VALUES (?, 1, 900, 99)").run(`replacement-${suffix}`);
    state.input.resetProofs.push({ operationId: `reset-${suffix}`, previousInstallationId: `previous-${suffix}`,
      replacementInstallationId: `replacement-${suffix}`, kind: "legacy-atomic", evidenceSha256: "e".repeat(64), participantId: "inference", preparedAt: 1 });
  }

  it.each([9, 10, 11, 12])("inventories independently applied prefix %i without replaying DDL or routing seeds", (count) => {
    const state = complete(count);
    const routing = state.database.prepare("SELECT * FROM managed_inference_routing").all();
    const first = planInstallationMigrationAdoption(state.input);
    applyOwner(state, first, 0);
    applyOwner(state, planInstallationMigrationAdoption(state.input), 1);
    expect(planInstallationMigrationAdoption(state.input).handoffComplete).toBe(true);
    expect(state.database.prepare("SELECT * FROM managed_inference_routing").all()).toEqual(routing);
    expect(first.owners.flatMap((owner) => owner.seed)).toHaveLength(count);
  });

  it("detects a missing preparation guard and broken reference state", () => {
    const state = complete();
    state.database.exec("DROP TRIGGER installation_reset_preparation_guard");
    expect(() => planInstallationMigrationAdoption(state.input)).toThrow(/schema disagrees/);
    const invalid = complete();
    invalid.database.exec("PRAGMA foreign_keys = OFF; INSERT INTO managed_inference_policies VALUES ('missing', 1, 1, 1)");
    expect(() => planInstallationMigrationAdoption(invalid.input)).toThrow(/broken foreign key/);
  });

  it.each(["reserved", "provisioning", "active"])("imports a verified legacy %s reset as prepared and preserves later policy edits and deletion state", (replacementState) => {
    const state = complete();
    reset(state, replacementState);
    const policies = state.database.prepare("SELECT * FROM managed_inference_policies ORDER BY installation_id").all();
    const directory = state.database.prepare("SELECT * FROM installation_reset_operations").all();
    const first = planInstallationMigrationAdoption(state.input);
    expect(first.resetImports).toHaveLength(1);
    const imported = first.resetImports[0];
    expect(imported.insertReceipt).toBe(true);
    expect(imported.insertPreparedParticipant).toBe(true);
    state.database.prepare("INSERT INTO managed_inference_reset_receipts VALUES (?, ?, ?, ?)")
      .run(imported.operationId, imported.previousInstallationId, imported.replacementInstallationId, imported.preparedAt);
    const lostReply = planInstallationMigrationAdoption(state.input);
    expect(lostReply.resetImports[0].insertReceipt).toBe(false);
    state.database.prepare("INSERT INTO installation_reset_participants VALUES (?, ?, 'prepared', ?)")
      .run(imported.operationId, imported.participantId, imported.preparedAt);
    expect(planInstallationMigrationAdoption(state.input).resetImports).toEqual([]);
    expect(state.database.prepare("SELECT * FROM managed_inference_policies ORDER BY installation_id").all()).toEqual(policies);
    expect(state.database.prepare("SELECT * FROM installation_reset_operations").all()).toEqual(directory);
  });

  it("requires explicit historical provenance and keeps service preparation pending", () => {
    const state = complete();
    reset(state, "reserved");
    expect(() => planInstallationMigrationAdoption({ ...state.input, resetProofs: [] })).toThrow(/explicit operation-bound provenance/);
    state.input.resetProofs[0].kind = "service-preparation";
    expect(() => planInstallationMigrationAdoption(state.input)).toThrow(/missing its frozen participant/);
    state.database.exec("INSERT INTO installation_reset_participants VALUES ('reset-1', 'inference', 'pending', 42)");
    expect(planInstallationMigrationAdoption(state.input).resetImports).toEqual([]);
    expect(state.database.prepare("SELECT state, updated_at FROM installation_reset_participants").all()).toEqual([{ state: "pending", updated_at: 42 }]);
    state.input.resetProofs[0].kind = "legacy-atomic";
    expect(() => planInstallationMigrationAdoption(state.input)).toThrow(/legacy atomic/);
  });

  it("does not backfill historical resets before the new receipt and participant tables exist", () => {
    const state = complete(9);
    reset(state, "active");
    const plan = planInstallationMigrationAdoption(state.input);
    expect(plan.resetImports).toEqual([]);
    expect(plan.pendingForwardMigrations).toHaveLength(3);
    expect(plan.resetImportsRequireMigrations).toEqual(["0011_installation_reset_preparations.sql", "0012_inference_reset_receipts.sql"]);
  });

  it("retains every operation in a reset chain and rejects conflicting receipt identities", () => {
    const state = complete();
    reset(state, "retained", "1");
    reset(state, "active", "2");
    state.database.exec("UPDATE installation_reset_operations SET previous_installation_id = 'replacement-1' WHERE operation_id = 'reset-2'");
    state.database.exec("UPDATE managed_inference_policies SET enabled = 0 WHERE installation_id = 'replacement-1'");
    state.input.resetProofs[1].previousInstallationId = "replacement-1";
    const plan = planInstallationMigrationAdoption(state.input);
    expect(plan.resetImports.map((entry) => [entry.previousInstallationId, entry.replacementInstallationId]))
      .toEqual([["previous-1", "replacement-1"], ["replacement-1", "replacement-2"]]);
    expect(state.database.prepare("SELECT data_deletion_state FROM installation_reset_operations").all())
      .toEqual([{ data_deletion_state: "pending" }, { data_deletion_state: "pending" }]);
    state.database.exec("INSERT INTO managed_inference_reset_receipts VALUES ('reset-1', 'previous-2', 'replacement-1', 1)");
    expect(() => planInstallationMigrationAdoption(state.input)).toThrow(/receipt identity disagrees/);
  });
});
