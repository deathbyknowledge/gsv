import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import { administerOperatorBootstrap } from "../src/operator-bootstrap.ts";
import type { MigrationD1Database, MigrationD1Row } from "../src/installation-migration-d1.ts";

const workers = new Set<Miniflare>();
afterEach(async () => { for (const worker of workers) await worker.dispose(); workers.clear(); });

async function fixture() {
  const worker = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('fixture'); } }",
    compatibilityDate: "2026-07-29", d1Databases: { DB: "11111111-1111-4111-8111-111111111111" } });
  workers.add(worker);
  const db = await worker.getD1Database("DB");
  const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../workers/installations/migrations");
  for (const migration of await readD1Migrations(directory)) await db.batch(migration.queries.map((sql) => db.prepare(sql)));
  const database: MigrationD1Database = { identity: { accountId: "fixture", databaseId: "fixture" }, async batch(statements) {
    const results = await db.batch<MigrationD1Row>(statements.map(({ sql, params }) => db.prepare(sql).bind(...params ?? [])));
    return results.map((result) => result.results);
  } };
  return { db, database };
}

describe("deployment-owned operator bootstrap", () => {
  it("refuses noninteractive credential issuance before contacting Cloudflare", () => {
    const command = fileURLToPath(new URL("../src/operator-bootstrap-command.ts", import.meta.url));
    const result = spawnSync(process.execPath, [command, "issue", "--account", "a".repeat(32), "--database",
      "11111111-1111-4111-8111-111111111111", "--origin", "https://accounts.example.com", "--mode", "operator"],
    { detached: true, encoding: "utf8", timeout: 5000, env: { ...process.env, CLOUDFLARE_API_TOKEN: "fixture-never-send" } });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("No credentials were logged");
    expect(result.stderr).not.toContain("fixture-never-send");
  });
  it("issues once on a fresh public schema and keeps redeployment inert", async () => {
    const { db, database } = await fixture();
    const first = await administerOperatorBootstrap({ database, action: "issue", mode: "operator" });
    expect(first.secret).toMatch(/^bootstrap_[\w-]{43}$/);
    const before = (await db.prepare("SELECT * FROM operator_bootstrap").all()).results;
    expect(await administerOperatorBootstrap({ database, action: "issue", mode: "operator" })).toEqual({ state: "unchanged" });
    expect((await db.prepare("SELECT * FROM operator_bootstrap").all()).results).toEqual(before);
    expect(JSON.stringify(before)).not.toContain(first.secret);
  });

  it("reissues only an unstarted link and never creates another first installation during recovery", async () => {
    const { db, database } = await fixture();
    const first = await administerOperatorBootstrap({ database, action: "issue", mode: "operator" });
    const reissued = await administerOperatorBootstrap({ database, action: "reissue-bootstrap", mode: "operator" });
    expect(reissued.secret).not.toBe(first.secret);
    await db.prepare("UPDATE operator_bootstrap SET started_at = 1, handle = 'first'").run();
    const before = (await db.prepare("SELECT * FROM operator_bootstrap").all()).results;
    await expect(administerOperatorBootstrap({ database, action: "reissue-bootstrap", mode: "operator" })).rejects.toThrow(/unstarted/);
    const rotated = await administerOperatorBootstrap({ database, action: "rotate-operator", mode: "operator" });
    expect(rotated.secret).toMatch(/^operator_[\w-]{43}$/);
    const credential = await db.prepare("SELECT token_hash, revoked_at FROM operator_credentials").first();
    expect(credential?.token_hash).toBe(createHash("sha256").update(rotated.secret ?? "").digest("hex"));
    expect((await db.prepare("SELECT * FROM operator_bootstrap").all()).results).toEqual(before);
    const next = await administerOperatorBootstrap({ database, action: "rotate-operator", mode: "operator" });
    expect(next.secret).not.toBe(rotated.secret);
    expect((await db.prepare("SELECT token_hash FROM operator_credentials").first())?.token_hash).not.toBe(credential?.token_hash);
    await administerOperatorBootstrap({ database, action: "revoke-operator", mode: "operator" });
    expect((await db.prepare("SELECT revoked_at FROM operator_credentials").first())?.revoked_at).not.toBeNull();
    expect((await db.prepare("SELECT * FROM operator_bootstrap").all()).results).toEqual(before);
  });

  it("does not initialize an already-used directory or turn Access into operator access", async () => {
    const { db, database } = await fixture();
    await db.prepare("INSERT INTO principals VALUES ('principal', 'owner@example.invalid', 'owner@example.invalid', 'Owner', 1, 'active', 1, 1)").run();
    await db.prepare(`INSERT INTO installations (id, owner_principal_id, handle, canonical_origin, state, provision_version, created_at)
      VALUES ('existing', 'principal', 'first', 'https://first.example.com', 'active', 1, 1)`).run();
    expect(await administerOperatorBootstrap({ database, action: "issue", mode: "operator" })).toEqual({ state: "unchanged" });
    expect((await db.prepare("SELECT * FROM operator_bootstrap").all()).results).toEqual([]);
    await expect(administerOperatorBootstrap({ database, action: "rotate-operator", mode: "operator" })).rejects.toThrow(/already-started/);
    const fresh = await fixture();
    await administerOperatorBootstrap({ database: fresh.database, action: "issue", mode: "access" });
    await expect(administerOperatorBootstrap({ database: fresh.database, action: "rotate-operator", mode: "operator" })).rejects.toThrow(/mode differs/);
  });

  it("recovers a lost issuance reply only through explicit reissue", async () => {
    const { database } = await fixture();
    let failOnce = true;
    const lossy: MigrationD1Database = { identity: database.identity, async batch(statements) {
      const result = await database.batch(statements);
      if (failOnce && statements.some(({ sql }) => sql.startsWith("INSERT INTO operator_bootstrap"))) {
        failOnce = false;
        throw new Error("fixture lost commit reply");
      }
      return result;
    } };
    await expect(administerOperatorBootstrap({ database: lossy, action: "issue", mode: "operator" })).rejects.toThrow(/lost commit reply/);
    expect(await administerOperatorBootstrap({ database, action: "issue", mode: "operator" })).toEqual({ state: "unchanged" });
    expect((await administerOperatorBootstrap({ database, action: "reissue-bootstrap", mode: "operator" })).secret).toMatch(/^bootstrap_/);
  });
});
