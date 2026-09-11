import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as z from "zod/mini";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { Miniflare } from "miniflare";
import { unstable_splitSqlQuery } from "wrangler";
import { afterEach, describe, expect, it } from "vitest";
import type { HistoricalResetProof, MigrationAdoptionContext } from "../src/installation-migration-adoption.ts";
import { cloudflareMigrationD1, type MigrationD1Database, type MigrationD1Row } from "../src/installation-migration-d1.ts";
import { cancelRemoteInstallationMigrationAdoption, executeRemoteInstallationMigrationAdoption, prepareRemoteInstallationMigrationAdoption } from "../src/installation-migration-adoption-remote.ts";
import { runInstallationMigrationCommand, readMigrationCommandRequest } from "../src/installation-migration-command.ts";
import { runOwnedInstallationMigrations } from "../src/installation-migration-runner.ts";
import { installationMigrationInventory } from "../src/installation-migration-inventory.ts";
import { captureMigrationSnapshot, readMigrationFreeze } from "../src/installation-migration-freeze.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workers = new Set<Miniflare>();
const artifactDirectories: string[] = [];
afterEach(async () => { for (const worker of workers) await worker.dispose(); workers.clear();
  for (const directory of artifactDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const context: MigrationAdoptionContext = {
  operationId: "remote-fixture", environment: "fixture", accountId: "account", databaseId: "database",
  legacyRunnerRevision: "a".repeat(40), directoryRunnerRevision: "b".repeat(40), policyRunnerRevision: "c".repeat(40),
  legacySourceEvidenceSha256: "d".repeat(64), legacyRunnerFrozen: true,
  legacyLedger: "d1_migrations", directoryLedger: "installation_migrations", policyLedger: "inference_migrations",
};

async function fixture(directory = path.join(root, "workers/installations/migrations"), count = 2) {
  const worker = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('fixture'); } }",
    compatibilityDate: "2026-07-29", d1Databases: { DB: "11111111-1111-4111-8111-111111111111" } });
  workers.add(worker);
  const db = await worker.getD1Database("DB");
  const migrations = (await readD1Migrations(directory)).slice(0, count);
  await db.prepare("CREATE TABLE d1_migrations (id TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)").run();
  for (const [index, migration] of migrations.entries()) {
    await db.batch([...migration.queries.map((sql) => db.prepare(sql)),
      db.prepare("INSERT INTO d1_migrations VALUES (?, ?, ?)").bind(String(index + 1).padStart(5, "0"), migration.name, "2026-09-01 00:00:00")]);
  }
  await db.prepare("INSERT INTO principals VALUES ('principal', 'owner@example.invalid', 'owner@example.invalid', 'Owner', 1, 'active', 1, 1)").run();
  const database: MigrationD1Database = {
    identity: { accountId: context.accountId, databaseId: context.databaseId },
    async batch(statements) {
      const results = await db.batch<MigrationD1Row>(statements.map((statement) => db.prepare(statement.sql).bind(...statement.params ?? [])));
      return results.map((result) => result.results);
    },
  };
  const sources = migrations.map(({ name }) => ({ name, sql: readFileSync(path.join(directory, name), "utf8") }));
  const resetProofs: HistoricalResetProof[] = [];
  return { db, database, input: { database, context, sources, resetProofs } };
}

describe("remote D1 ownership handoff", () => {
  it("freezes writes, adopts both ledgers atomically, verifies preservation, and retires the legacy runner", async () => {
    const state = await fixture();
    const before = await state.db.prepare("SELECT * FROM principals").all();
    const prepared = await prepareRemoteInstallationMigrationAdoption(state.input);
    prepared.snapshot.close();
    await expect(state.db.prepare("UPDATE principals SET display_name = 'Blocked'").run()).rejects.toThrow(/frozen writes/);
    const receipt = await executeRemoteInstallationMigrationAdoption({ ...state.input, approvedPreconditionSha256: prepared.plan.preconditionSha256 });
    expect(receipt.phase).toBe("released");
    expect((await state.db.prepare("SELECT * FROM principals").all()).results).toEqual(before.results);
    expect((await state.db.prepare("SELECT COUNT(*) AS n FROM installation_migrations").first())?.n).toBe(2);
    await state.db.prepare("UPDATE principals SET display_name = 'Allowed after handoff'").run();
    await expect(state.db.prepare("INSERT INTO d1_migrations VALUES ('3', 'unsafe.sql', '2026-09-01')").run()).rejects.toThrow(/frozen writes/);
    expect(await executeRemoteInstallationMigrationAdoption({ ...state.input, approvedPreconditionSha256: prepared.plan.preconditionSha256 })).toEqual(receipt);
  });

  it("recovers a committed adoption whose response was lost without replaying DDL", async () => {
    const state = await fixture();
    const prepared = await prepareRemoteInstallationMigrationAdoption(state.input);
    prepared.snapshot.close();
    let loseReply = true;
    const lossy: MigrationD1Database = { identity: state.database.identity, async batch(statements) {
      const result = await state.database.batch(statements);
      if (loseReply && statements.some((statement) => statement.sql.startsWith("CREATE TABLE \"installation_migrations\""))) {
        loseReply = false;
        throw new Error("lost response after commit");
      }
      return result;
    } };
    const input = { ...state.input, database: lossy, approvedPreconditionSha256: prepared.plan.preconditionSha256 };
    await expect(executeRemoteInstallationMigrationAdoption(input)).rejects.toThrow(/lost response/);
    expect((await readMigrationFreeze(state.database))?.phase).toBe("adopted");
    await expect(state.db.prepare("UPDATE principals SET display_name = 'Still blocked'").run()).rejects.toThrow(/frozen writes/);
    expect((await executeRemoteInstallationMigrationAdoption(input)).phase).toBe("released");
  });

  it("preserves Wrangler integer ledger IDs and the legacy autoincrement sequence", async () => {
    const state = await fixture();
    await state.db.batch([
      state.db.prepare("ALTER TABLE d1_migrations RENAME TO former"),
      state.db.prepare("CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)"),
      state.db.prepare("INSERT INTO d1_migrations SELECT * FROM former"), state.db.prepare("DROP TABLE former"),
    ]);
    const prepared = await prepareRemoteInstallationMigrationAdoption(state.input);
    prepared.snapshot.close();
    await executeRemoteInstallationMigrationAdoption({ ...state.input, approvedPreconditionSha256: prepared.plan.preconditionSha256 });
    expect((await state.db.prepare("SELECT name, seq FROM sqlite_sequence").all()).results).toEqual([{ name: "d1_migrations", seq: 2 }]);
    expect((await state.db.prepare("SELECT id FROM installation_migrations ORDER BY id").all()).results).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("rejects stale approval and can cancel an uncommitted freeze", async () => {
    const state = await fixture();
    const prepared = await prepareRemoteInstallationMigrationAdoption(state.input);
    prepared.snapshot.close();
    await expect(executeRemoteInstallationMigrationAdoption({ ...state.input, approvedPreconditionSha256: "f".repeat(64) })).rejects.toThrow(/precondition changed/);
    expect((await readMigrationFreeze(state.database))?.phase).toBe("frozen");
    await cancelRemoteInstallationMigrationAdoption(state.input);
    await state.db.prepare("UPDATE principals SET display_name = 'Resumed'").run();
    expect((await readMigrationFreeze(state.database))?.phase).toBe("cancelled");
  });

  it("preserves exact large integers, real values, and blobs while capturing D1 rows", async () => {
    const state = await fixture();
    await state.db.prepare("UPDATE principals SET created_at = 9007199254740993, updated_at = 3.141592653589793, display_name = X'00ff0102'").run();
    const prepared = await prepareRemoteInstallationMigrationAdoption(state.input);
    const row = prepared.snapshot.prepare("SELECT CAST(created_at AS TEXT) AS created, printf('%!.17g', updated_at) AS updated, hex(display_name) AS name FROM principals").get();
    expect(row).toEqual({ created: "9007199254740993", updated: "3.1415926535897931", name: "00FF0102" });
    prepared.snapshot.close();
    expect((await executeRemoteInstallationMigrationAdoption({ ...state.input, approvedPreconditionSha256: prepared.plan.preconditionSha256 })).phase).toBe("released");
  });

  it("rolls back all ownership changes when any statement in the D1 batch fails", async () => {
    const state = await fixture();
    const prepared = await prepareRemoteInstallationMigrationAdoption(state.input);
    prepared.snapshot.close();
    const failing: MigrationD1Database = { identity: state.database.identity, batch(statements) {
      return state.database.batch(statements.some((statement) => statement.sql.startsWith("CREATE TABLE \"installation_migrations\""))
        ? [...statements, { sql: "INSERT INTO table_that_does_not_exist VALUES (1)" }] : statements);
    } };
    await expect(executeRemoteInstallationMigrationAdoption({ ...state.input, database: failing, approvedPreconditionSha256: prepared.plan.preconditionSha256 })).rejects.toThrow();
    expect((await readMigrationFreeze(state.database))?.phase).toBe("frozen");
    expect((await state.db.prepare("SELECT name FROM sqlite_schema WHERE name = 'installation_migrations'").all()).results).toEqual([]);
    const frozen = await readMigrationFreeze(state.database);
    if (!frozen) throw new Error("Expected durable freeze");
    (await captureMigrationSnapshot(state.database, frozen)).close();
  });
});

const privateMigrations = process.env.GSV_ADOPTION_LEGACY_MIGRATIONS;
describe.skipIf(!privateMigrations)("remote adoption with actual private migration sources", () => {
  async function complete(count = 12) { return fixture(privateMigrations, count); }
  async function addReset(state: Awaited<ReturnType<typeof complete>>) {
    for (const [id, status] of [["previous", "retained"], ["replacement", "active"]]) {
      await state.db.prepare("INSERT INTO installations (id, owner_principal_id, handle, canonical_origin, state, provision_version, created_at) VALUES (?, 'principal', ?, ?, ?, 1, 1)")
        .bind(id, id, `https://${id}.example.invalid`, status).run();
    }
    await state.db.batch([
      state.db.prepare("INSERT INTO installation_reset_operations VALUES ('reset', 'previous', 'replacement', 'ship', 'https://ship.example.invalid', 'ship.example.invalid', 'pending', NULL, 1, 2, NULL)"),
      state.db.prepare("INSERT INTO managed_inference_policies VALUES ('previous', 0, 100, 2)"),
      state.db.prepare("INSERT INTO managed_inference_policies VALUES ('replacement', 1, 900, 99)"),
    ]);
    state.input.resetProofs.push({ operationId: "reset", previousInstallationId: "previous", replacementInstallationId: "replacement",
      kind: "legacy-atomic", evidenceSha256: "e".repeat(64), participantId: "inference", preparedAt: 1 });
  }

  it.each([9, 10, 11, 12])("adopts legacy prefix %i without replaying routing seeds or changing policies", async (count) => {
    const state = await complete(count);
    const before = (await state.db.prepare("SELECT * FROM managed_inference_routing").all()).results;
    const prepared = await prepareRemoteInstallationMigrationAdoption(state.input);
    prepared.snapshot.close();
    await executeRemoteInstallationMigrationAdoption({ ...state.input, approvedPreconditionSha256: prepared.plan.preconditionSha256 });
    expect((await state.db.prepare("SELECT * FROM managed_inference_routing").all()).results).toEqual(before);
    expect((await state.db.prepare("SELECT (SELECT COUNT(*) FROM installation_migrations) + (SELECT COUNT(*) FROM inference_migrations) AS n").first())?.n).toBe(count);
  });

  it.each([false, true])("imports verified historical preparation once without recopying policies (receipt=%s)", async (receiptExists) => {
    const state = await complete();
    await addReset(state);
    if (receiptExists) await state.db.prepare("INSERT INTO managed_inference_reset_receipts VALUES ('reset', 'previous', 'replacement', 7)").run();
    const policies = (await state.db.prepare("SELECT * FROM managed_inference_policies ORDER BY installation_id").all()).results;
    const resets = (await state.db.prepare("SELECT * FROM installation_reset_operations").all()).results;
    const prepared = await prepareRemoteInstallationMigrationAdoption(state.input);
    prepared.snapshot.close();
    const input = { ...state.input, approvedPreconditionSha256: prepared.plan.preconditionSha256 };
    await executeRemoteInstallationMigrationAdoption(input);
    expect((await state.db.prepare("SELECT * FROM installation_reset_participants").all()).results).toEqual([
      { operation_id: "reset", participant_id: "inference", state: "prepared", updated_at: receiptExists ? 7 : 1 },
    ]);
    expect((await state.db.prepare("SELECT * FROM managed_inference_policies ORDER BY installation_id").all()).results).toEqual(policies);
    expect((await state.db.prepare("SELECT * FROM installation_reset_operations").all()).results).toEqual(resets);
    expect((await executeRemoteInstallationMigrationAdoption(input)).phase).toBe("released");
  });

  it("runs only owner forward SQL with immutable checksums and atomic ledger writes", async () => {
    const state = await complete();
    const prepared = await prepareRemoteInstallationMigrationAdoption(state.input);
    prepared.snapshot.close();
    await executeRemoteInstallationMigrationAdoption({ ...state.input, approvedPreconditionSha256: prepared.plan.preconditionSha256 });
    const sources = state.input.sources.map((source) => ({ ...source,
      owner: installationMigrationInventory.find((entry) => entry.name === source.name)!.owner }));
    sources.push({ owner: "directory", name: "0013_forward_fixture.sql", sql: "CREATE TABLE forward_fixture (id TEXT); INSERT INTO forward_fixture VALUES ('one');" });
    const input = { database: state.database, operationId: context.operationId, sources };
    expect(await runOwnedInstallationMigrations(input)).toEqual({ applied: ["0013_forward_fixture.sql"] });
    expect((await state.db.prepare("SELECT * FROM forward_fixture").all()).results).toEqual([{ id: "one" }]);
    expect(await runOwnedInstallationMigrations(input)).toEqual({ applied: [] });
    sources[sources.length - 1].sql = "CREATE TABLE forward_fixture (different TEXT)";
    await expect(runOwnedInstallationMigrations(input)).rejects.toThrow(/source changed/);
  });

  it("keeps REST result cardinality exact for forward files containing triggers and multiple statements", async () => {
    const state = await complete();
    const identity = { accountId: "a".repeat(32), databaseId: "11111111-1111-4111-8111-111111111111" };
    const adoption = { ...state.input, database: { ...state.database, identity }, context: { ...context, ...identity } };
    const prepared = await prepareRemoteInstallationMigrationAdoption(adoption);
    prepared.snapshot.close();
    await executeRemoteInstallationMigrationAdoption({ ...adoption, approvedPreconditionSha256: prepared.plan.preconditionSha256 });
    const sources = state.input.sources.map((source) => ({ ...source,
      owner: installationMigrationInventory.find((entry) => entry.name === source.name)!.owner }));
    sources.push({ owner: "directory", name: "0013_rest_fixture.sql", sql: `
      CREATE TABLE rest_fixture (id TEXT);
      CREATE TABLE rest_audit (value TEXT);
      CREATE TRIGGER rest_insert AFTER INSERT ON rest_fixture BEGIN
        INSERT INTO rest_audit VALUES (new.id || '; first');
        INSERT INTO rest_audit VALUES (new.id || '; second');
      END;
      -- A comment with a semicolon; is not a statement boundary.
      INSERT INTO rest_fixture VALUES ('one;value');` });
    const requestSchema = z.object({ batch: z.array(z.object({ sql: z.string(), params: z.optional(z.array(z.string())) })) });
    const database = cloudflareMigrationD1({ ...identity, apiToken: "fixture-never-sent", async fetch(_url, init) {
      const { batch } = requestSchema.parse(JSON.parse(String(init?.body)));
      // The REST endpoint returns results for each SQL statement, unlike the
      // local D1 binding's result grouping for a multi-statement batch item.
      const expanded = batch.flatMap(({ sql, params }) => unstable_splitSqlQuery(sql).map((query) => state.db.prepare(query).bind(...params ?? [])));
      const result = await state.db.batch<MigrationD1Row>(expanded);
      return Response.json({ success: true, result: result.map((entry) => ({ success: entry.success, results: entry.results })) });
    } });
    const input = { database, operationId: context.operationId, sources };
    expect(await runOwnedInstallationMigrations(input)).toEqual({ applied: ["0013_rest_fixture.sql"] });
    expect((await state.db.prepare("SELECT value FROM rest_audit ORDER BY value").all()).results)
      .toEqual([{ value: "one;value; first" }, { value: "one;value; second" }]);
    expect(await runOwnedInstallationMigrations(input)).toEqual({ applied: [] });
  });

  it("rolls back a failed forward migration and recovers its lost successful reply", async () => {
    const state = await complete();
    const prepared = await prepareRemoteInstallationMigrationAdoption(state.input);
    prepared.snapshot.close();
    const sources = state.input.sources.map((source) => ({ ...source,
      owner: installationMigrationInventory.find((entry) => entry.name === source.name)!.owner }));
    await expect(runOwnedInstallationMigrations({ database: state.database, operationId: context.operationId, sources })).rejects.toThrow(/both migration owners/i);
    await executeRemoteInstallationMigrationAdoption({ ...state.input, approvedPreconditionSha256: prepared.plan.preconditionSha256 });
    sources.push({ owner: "policy", name: "0013_forward_failure.sql", sql: "CREATE TABLE should_rollback (id TEXT); INSERT INTO nonexistent VALUES (1);" });
    await expect(runOwnedInstallationMigrations({ database: state.database, operationId: context.operationId, sources })).rejects.toThrow();
    expect((await state.db.prepare("SELECT name FROM sqlite_schema WHERE name IN ('should_rollback', 'installation_migration_sources')").all()).results).toEqual([]);
    sources[sources.length - 1].sql = "CREATE TABLE should_rollback (id TEXT); INSERT INTO should_rollback VALUES ('once');";
    let loseReply = true;
    const lossy: MigrationD1Database = { identity: state.database.identity, async batch(statements) {
      const result = await state.database.batch(statements);
      if (loseReply && statements.some((statement) => statement.sql.includes("CREATE TABLE should_rollback"))) {
        loseReply = false; throw new Error("lost forward reply");
      }
      return result;
    } };
    await expect(runOwnedInstallationMigrations({ database: lossy, operationId: context.operationId, sources })).rejects.toThrow(/lost forward/);
    expect(await runOwnedInstallationMigrations({ database: lossy, operationId: context.operationId, sources })).toEqual({ applied: [] });
    expect((await state.db.prepare("SELECT * FROM should_rollback").all()).results).toEqual([{ id: "once" }]);
  });

  it("runs the operator command from exact Git sources and retains a private reviewed snapshot", async () => {
    const state = await complete();
    const directory = mkdtempSync(path.join(tmpdir(), "gsv-remote-command-"));
    artifactDirectories.push(directory);
    for (const name of ["legacy", "directory", "policy"]) mkdirSync(path.join(directory, name));
    for (const source of state.input.sources) {
      const owner = installationMigrationInventory.find((entry) => entry.name === source.name)!.owner;
      writeFileSync(path.join(directory, "legacy", source.name), source.sql);
      writeFileSync(path.join(directory, owner, source.name), source.sql);
    }
    writeFileSync(path.join(directory, "directory", "0013_command_fixture.sql"), "CREATE TABLE command_fixture (id TEXT); INSERT INTO command_fixture VALUES ('exact revision');");
    const git = (args: string[]): string => execFileSync("git", ["-C", directory, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git(["init", "--quiet"]); git(["add", "legacy", "directory", "policy"]);
    git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture sources"]);
    const revision = git(["rev-parse", "HEAD"]);
    const evidence = "fixture source provenance reviewed for a synthetic database";
    writeFileSync(path.join(directory, "source-evidence.txt"), evidence);
    const requestFile = path.join(directory, "request.json");
    writeFileSync(requestFile, JSON.stringify({ context: { ...context, legacyRunnerRevision: revision,
      directoryRunnerRevision: revision, policyRunnerRevision: revision,
      legacySourceEvidenceSha256: createHash("sha256").update(evidence).digest("hex") },
      legacy: { repository: ".", directory: "legacy" }, directory: { repository: ".", directory: "directory" },
      policy: { repository: ".", directory: "policy" }, sourceProvenanceFile: "source-evidence.txt", resetProofs: [] }));
    const outputDirectory = path.join(directory, "snapshot");
    const prepared = z.object({ phase: z.literal("frozen"), preconditionSha256: z.string() }).parse(
      await runInstallationMigrationCommand({ action: "prepare", requestFile, database: state.database, outputDirectory }));
    expect(statSync(outputDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(outputDirectory, "snapshot.sqlite")).mode & 0o777).toBe(0o600);
    expect(statSync(path.join(outputDirectory, "plan.json")).mode & 0o777).toBe(0o600);
    const artifact = z.object({ snapshotSha256: z.string() }).parse(JSON.parse(readFileSync(path.join(outputDirectory, "plan.json"), "utf8")));
    expect(artifact.snapshotSha256).toBe(createHash("sha256").update(readFileSync(path.join(outputDirectory, "snapshot.sqlite"))).digest("hex"));
    await runInstallationMigrationCommand({ action: "apply", requestFile, database: state.database,
      approvedPreconditionSha256: prepared.preconditionSha256 });
    // An uncommitted working-copy edit cannot replace reviewed SQL.
    writeFileSync(path.join(directory, "directory", "0013_command_fixture.sql"), "DROP TABLE principals;");
    expect(await runInstallationMigrationCommand({ action: "forward", requestFile, database: state.database })).toEqual({ applied: ["0013_command_fixture.sql"] });
    expect((await state.db.prepare("SELECT * FROM command_fixture").all()).results).toEqual([{ id: "exact revision" }]);
    writeFileSync(path.join(directory, "source-evidence.txt"), "changed evidence");
    expect(() => readMigrationCommandRequest(requestFile)).toThrow(/artifact does not match/);
  });

  it("does not turn pending service preparation into a fabricated completed receipt", async () => {
    const state = await complete();
    await addReset(state);
    await state.db.batch([
      state.db.prepare("UPDATE installations SET state = 'reserved' WHERE id = 'replacement'"),
      state.db.prepare("INSERT INTO installation_reset_participants VALUES ('reset', 'inference', 'pending', 8)"),
    ]);
    state.input.resetProofs[0].kind = "service-preparation";
    const prepared = await prepareRemoteInstallationMigrationAdoption(state.input);
    prepared.snapshot.close();
    await executeRemoteInstallationMigrationAdoption({ ...state.input, approvedPreconditionSha256: prepared.plan.preconditionSha256 });
    expect((await state.db.prepare("SELECT state, updated_at FROM installation_reset_participants").all()).results).toEqual([{ state: "pending", updated_at: 8 }]);
    expect((await state.db.prepare("SELECT * FROM managed_inference_reset_receipts").all()).results).toEqual([]);
  });

  it("rejects missing reset evidence and wrong identities before freezing any writes", async () => {
    const state = await complete();
    await addReset(state);
    await expect(prepareRemoteInstallationMigrationAdoption({ ...state.input, resetProofs: [] })).rejects.toThrow(/operation-bound provenance/);
    expect(await readMigrationFreeze(state.database)).toBeNull();
    await state.db.prepare("UPDATE principals SET display_name = 'Still available'").run();
    state.input.resetProofs[0].replacementInstallationId = "wrong";
    await expect(prepareRemoteInstallationMigrationAdoption(state.input)).rejects.toThrow();
    expect(await readMigrationFreeze(state.database)).toBeNull();
  });
});

describe("remote handoff guards", () => {
  it("recovers a lost freeze and release reply without exposing an unverified phase", async () => {
    const state = await fixture();
    let loseFreeze = true;
    let loseRelease = true;
    const lossy: MigrationD1Database = { identity: state.database.identity, async batch(statements) {
      const result = await state.database.batch(statements);
      if (loseFreeze && statements.some((statement) => statement.sql.startsWith("CREATE TABLE installation_migration_freeze"))) {
        loseFreeze = false; throw new Error("lost freeze reply");
      }
      if (loseRelease && statements.some((statement) => statement.sql.startsWith("DROP TRIGGER"))) {
        loseRelease = false; throw new Error("lost release reply");
      }
      return result;
    } };
    const input = { ...state.input, database: lossy };
    await expect(prepareRemoteInstallationMigrationAdoption(input)).rejects.toThrow(/lost freeze/);
    const prepared = await prepareRemoteInstallationMigrationAdoption(input);
    prepared.snapshot.close();
    const approved = { ...input, approvedPreconditionSha256: prepared.plan.preconditionSha256 };
    await expect(executeRemoteInstallationMigrationAdoption(approved)).rejects.toThrow(/lost release/);
    expect((await executeRemoteInstallationMigrationAdoption(approved)).phase).toBe("released");
  });

  it("rolls back the freeze if a concurrent migration adds an unobserved table", async () => {
    const state = await fixture();
    const racing: MigrationD1Database = { identity: state.database.identity, async batch(statements) {
      if (statements.some((statement) => statement.sql.startsWith("CREATE TABLE installation_migration_freeze"))) {
        await state.db.prepare("CREATE TABLE concurrent_migration (id TEXT)").run();
      }
      return state.database.batch(statements);
    } };
    await expect(prepareRemoteInstallationMigrationAdoption({ ...state.input, database: racing })).rejects.toThrow(/CHECK constraint/);
    expect(await readMigrationFreeze(state.database)).toBeNull();
    await state.db.prepare("UPDATE principals SET display_name = 'Not frozen'").run();
  });

  it("rejects changed freeze guards and a mismatched remote database identity", async () => {
    const state = await fixture();
    const prepared = await prepareRemoteInstallationMigrationAdoption(state.input);
    prepared.snapshot.close();
    await expect(executeRemoteInstallationMigrationAdoption({ ...state.input,
      database: { ...state.database, identity: { ...state.database.identity, databaseId: "different" } },
      approvedPreconditionSha256: prepared.plan.preconditionSha256 })).rejects.toThrow(/different reviewed/);
    await state.db.prepare('DROP TRIGGER "installation_migration_freeze_principals_update"').run();
    await expect(executeRemoteInstallationMigrationAdoption({ ...state.input,
      approvedPreconditionSha256: prepared.plan.preconditionSha256 })).rejects.toThrow(/freeze is incomplete/);
  });
});
