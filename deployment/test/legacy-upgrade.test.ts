import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { legacyDatabaseProps, legacyDatabaseSeed } from "../acceptance/legacy-upgrade/database.ts";
import { fixtureAdminRequest } from "../acceptance/legacy-upgrade/fixture-admin.ts";
import { LEGACY_PRIVATE_REVISION, LEGACY_PUBLIC_REVISION, assertUpgradeEnvironment, assertUpgradeResourceContinuity, upgradeFixturePlan, upgradeFixtureSchema } from "../acceptance/legacy-upgrade/plan.ts";
import { assertUpgradeBuildReceipt } from "../acceptance/legacy-upgrade/receipt.ts";
import { readPrivateState, writePrivateState } from "../acceptance/legacy-upgrade/private-state.ts";
import { planInstallationMigrationAdoption } from "../src/installation-migration-adoption.ts";
import { installationMigrationInventory } from "../src/installation-migration-inventory.ts";

const fixture = upgradeFixtureSchema.parse({ accountId: "1".repeat(32), zoneId: "2".repeat(32), domain: "example.com", fixtureId: "a1b2c3d4", profile: "fixture",
  publicRepository: "/sources/public", privateRepository: "/sources/private", currentPublicRevision: "3".repeat(40), currentPrivateRevision: "4".repeat(40), artifactsDirectory: "/evidence" });
const plan = upgradeFixturePlan(fixture);
const secret = "a".repeat(64);
const environment = { FIXTURE_ADMIN_SECRET: secret, FIXTURE_ADMIN_ORIGIN: plan.adminOrigin };

it("seeds the original ledger for adoption and relinquishes DDL ownership before handoff", () => {
  expect(legacyDatabaseProps(plan.names.database, fixture.artifactsDirectory, "legacy"))
    .toEqual({ name: plan.names.database, importFiles: ["/evidence/legacy/migrations/database.seed.sql"] });
  for (const phase of ["handoff", "current"] as const) {
    expect(legacyDatabaseProps(plan.names.database, fixture.artifactsDirectory, phase)).toEqual({ name: plan.names.database });
  }
  const migrations = installationMigrationInventory.slice(0, 2).map(({ name }) => ({ name,
    sql: readFileSync(fileURLToPath(new URL(`../../workers/installations/migrations/${name}`, import.meta.url)), "utf8") }));
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(legacyDatabaseSeed(migrations.toReversed()));
    expect(database.prepare("PRAGMA table_info(d1_migrations)").all().map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk })))
      .toEqual([{ name: "id", type: "TEXT", notnull: 0, pk: 1 }, { name: "name", type: "TEXT", notnull: 1, pk: 0 },
        { name: "applied_at", type: "TEXT", notnull: 1, pk: 0 }]);
    const adoption = planInstallationMigrationAdoption({ database, sources: migrations, handoffs: [], resetProofs: [], context: {
      operationId: "fixture-adoption", environment: plan.stage, accountId: fixture.accountId, databaseId: "fixture-database",
      legacyRunnerRevision: LEGACY_PRIVATE_REVISION, directoryRunnerRevision: fixture.currentPublicRevision,
      policyRunnerRevision: fixture.currentPrivateRevision, legacySourceEvidenceSha256: "a".repeat(64), legacyRunnerFrozen: true,
      legacyLedger: "d1_migrations", directoryLedger: "installation_migrations", policyLedger: "inference_migrations",
    } });
    expect(adoption.owners.find(({ owner }) => owner === "directory")?.seed.map(({ id, name }) => ({ id, name })))
      .toEqual(migrations.map(({ name }, index) => ({ id: String(index + 1).padStart(5, "0"), name })));
  } finally { database.close(); }
});

describe("isolated legacy upgrade admission", () => {
  it("requires exact deployment account, profile and unique stage", () => {
    const env = { CLOUDFLARE_ACCOUNT_ID: fixture.accountId, ALCHEMY_PROFILE: fixture.profile };
    expect(() => assertUpgradeEnvironment(fixture, env, plan.stage)).not.toThrow();
    for (const stage of ["prod", "staging", "placeholder"]) expect(() => assertUpgradeEnvironment(fixture, env, stage)).toThrow();
    expect(() => assertUpgradeEnvironment(fixture, { ...env, CLOUDFLARE_ACCOUNT_ID: "5".repeat(32) }, plan.stage)).toThrow();
    expect(() => assertUpgradeEnvironment(fixture, { ...env, ALCHEMY_PROFILE: "default" }, plan.stage)).toThrow();
    expect(plan.gatewayHosts).toEqual(["upg-a1b2c3d4-a.example.com", "upg-a1b2c3d4-b.example.com"]);
    expect(Object.values(plan.names).every((name) => name.startsWith("gsv-upgrade-a1b2c3d4-"))).toBe(true);
  });

  it("rejects missing authority, unrelated hosts and non-fixture admin surfaces before delegation", async () => {
    for (const [url, headers] of [
      [`${plan.adminOrigin}/admin/api/installations`, {}],
      ["https://other.example.com/admin/api/installations", { authorization: `Bearer ${secret}` }],
      [`${plan.adminOrigin}/owner/root`, { authorization: `Bearer ${secret}` }],
    ] as const) {
      const result = await fixtureAdminRequest(new Request(url, { headers }), environment);
      expect(result).toBeInstanceOf(Response);
      if (result instanceof Response) expect(result.status).toBe(403);
    }
    const result = await fixtureAdminRequest(new Request(`${plan.adminOrigin}/admin/api/installations`, {
      method: "POST", headers: { authorization: `Bearer ${secret}`, origin: "https://other.example.com" }, body: "{}",
    }), environment);
    expect(result).toBeInstanceOf(Response);
    if (result instanceof Response) expect(result.status).toBe(403);
  });

  it("passes an authorized reset unchanged to historical localhost admission without forwarding credentials", async () => {
    const body = JSON.stringify({ operationId: "reset-fixture", confirmHandle: plan.handles[0] });
    const result = await fixtureAdminRequest(new Request(`${plan.adminOrigin}/admin/api/installations/inst_fixture/reset`, {
      method: "POST", headers: { authorization: `Bearer ${secret}`, origin: plan.adminOrigin, cookie: "session=fixture", "content-type": "application/json" }, body,
    }), environment);
    expect(result).toBeInstanceOf(Request);
    if (result instanceof Request) {
      expect(result.url).toBe("http://localhost/admin/api/installations/inst_fixture/reset");
      expect(result.headers.get("origin")).toBe("http://localhost");
      expect(result.headers.has("authorization")).toBe(false);
      expect(result.headers.has("cookie")).toBe(false);
      expect(await result.text()).toBe(body);
    }
  });
});

it("replaces complete credentials atomically and rejects exposed files or symlinks without overwriting their contents", () => {
  const directory = mkdtempSync(join(tmpdir(), "gsv-upgrade-state-"));
  const filename = join(directory, "credentials.json");
  try {
    writePrivateState(filename, "first complete state");
    const originalInode = statSync(filename).ino;
    writePrivateState(filename, "second complete state");
    expect(readPrivateState(filename)).toBe("second complete state");
    expect(statSync(filename).ino).not.toBe(originalInode);
    expect(statSync(filename).mode & 0o777).toBe(0o600);
    expect(readdirSync(directory)).toEqual(["credentials.json"]);
    chmodSync(filename, 0o644);
    expect(() => writePrivateState(filename, "must not write")).toThrow("private");
    expect(readFileSync(filename, "utf8")).toBe("second complete state");
    rmSync(filename);
    const target = join(directory, "target.json");
    writeFileSync(target, "do not follow", { mode: 0o600 });
    symlinkSync(target, filename);
    expect(() => writePrivateState(filename, "must not write")).toThrow();
    expect(readFileSync(target, "utf8")).toBe("do not follow");
    rmSync(filename);
    chmodSync(directory, 0o755);
    expect(() => writePrivateState(filename, "must not write")).toThrow("private directory");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it("blocks deployment when a previously reviewed build is changed, incomplete, extended or pinned elsewhere", () => {
  const artifactsDirectory = mkdtempSync(join(tmpdir(), "gsv-upgrade-test-"));
  const input = { ...fixture, artifactsDirectory };
  const hashes: Record<string, string> = {};
  const receipt = { phase: "legacy", publicRevision: LEGACY_PUBLIC_REVISION, privateRevision: LEGACY_PRIVATE_REVISION, hashes };
  const output = join(artifactsDirectory, "legacy");
  try {
    for (const name of ["accounts", "inference", "gateway", "ripgit", "web", "migrations"]) {
      mkdirSync(join(output, name), { recursive: true });
      writeFileSync(join(output, name, "index.js"), "reviewed");
      hashes[`${name}/index.js`] = createHash("sha256").update("reviewed").digest("hex");
    }
    writeFileSync(join(output, "receipt.json"), JSON.stringify(receipt));
    expect(() => assertUpgradeBuildReceipt(input, "legacy")).not.toThrow();
    writeFileSync(join(output, "gateway/index.js"), "unreviewed");
    expect(() => assertUpgradeBuildReceipt(input, "legacy")).toThrow("differs");
    writeFileSync(join(output, "gateway/index.js"), "reviewed");
    writeFileSync(join(output, "gateway/extra.js"), "unexpected");
    expect(() => assertUpgradeBuildReceipt(input, "legacy")).toThrow("differs");
    rmSync(join(output, "gateway/extra.js"));
    rmSync(join(output, "gateway/index.js"));
    expect(() => assertUpgradeBuildReceipt(input, "legacy")).toThrow("missing");
    writeFileSync(join(output, "gateway/index.js"), "reviewed");
    writeFileSync(join(output, "receipt.json"), JSON.stringify({ ...receipt, publicRevision: fixture.currentPublicRevision }));
    expect(() => assertUpgradeBuildReceipt(input, "legacy")).toThrow("source pins");
  } finally { rmSync(artifactsDirectory, { recursive: true, force: true }); }
});

describe("resource identity continuity", () => {
  const before = [{ kind: "worker", name: `${plan.prefix}-gateway`, id: "same-worker" }, { kind: "d1", name: "existing-personal-accounts", id: "unrelated-database" }];
  it("allows the fixture's new executor and preserves all unrelated identities", () => {
    expect(() => assertUpgradeResourceContinuity(before, [...before, { kind: "do", name: `${plan.prefix}-inference/InferenceExecutor`, id: "new-executor" }], plan.prefix)).not.toThrow();
  });
  it("fails on replacement, deletion, unrelated creation and ambiguous evidence", () => {
    expect(() => assertUpgradeResourceContinuity(before, [{ ...before[0], id: "replacement" }, before[1]], plan.prefix)).toThrow("Existing resource changed");
    expect(() => assertUpgradeResourceContinuity(before, [before[0]], plan.prefix)).toThrow("Existing resource changed");
    expect(() => assertUpgradeResourceContinuity(before, [...before, { kind: "worker", name: "production", id: "unexpected" }], plan.prefix)).toThrow("Unrelated resource created");
    expect(() => assertUpgradeResourceContinuity(before, [...before, before[0]], plan.prefix)).toThrow("duplicate identities");
  });
});
