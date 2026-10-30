import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { it } from "vitest";

const directory = new URL("../../workers/installations/migrations/", import.meta.url);
const migration = "0035_product_email_users.sql";
const source = (name: string) => readFileSync(new URL(name, directory), "utf8");

function previousDatabase() {
  const db = new DatabaseSync(":memory:");
  for (const name of readdirSync(directory).filter((name) => name.endsWith(".sql") && name < migration).sort()) db.exec(source(name));
  return db;
}

function owner(db: DatabaseSync, id: string, state = "active", verified: number | null = 1) {
  db.prepare(`INSERT INTO principals (id, primary_email, primary_email_normalized, display_name,
    email_verified_at, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 1)`)
    .run(id, `${id}@example.com`, `${id}@example.com`, id, verified, state);
}

function ship(db: DatabaseSync, id: string, principal: string, state = "active") {
  db.prepare(`INSERT INTO installations (id, owner_principal_id, handle, canonical_origin, state,
    provision_version, created_at) VALUES (?, ?, ?, ?, ?, 1, 1)`)
    .run(id, principal, id, `https://${id}.example.com`, state);
}

it("applies to a fresh database without enrolling future owners", () => {
  const db = previousDatabase();
  try {
    db.exec(source(migration));
    owner(db, "future");
    ship(db, "future", "future");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM product_email_signups").get()?.n, 0);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { db.close(); }
});

it("backfills each eligible owner once and excludes unverified, inactive and unfinished accounts", () => {
  const db = previousDatabase();
  try {
    owner(db, "eligible");
    ship(db, "first", "eligible");
    ship(db, "second", "eligible");
    owner(db, "disabled", "disabled");
    ship(db, "disabled", "disabled");
    owner(db, "unverified", "active", null);
    ship(db, "unverified", "unverified");
    owner(db, "no-ship");
    for (const state of ["reserved", "provisioning", "restricted", "cancelled", "retained", "deleting", "deleted"]) {
      owner(db, state);
      ship(db, state, state, state);
    }
    db.exec(source(migration));
    const rows = db.prepare("SELECT * FROM product_email_signups").all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].email, "eligible@example.com");
    assert.equal(rows[0].source, "ship-existing-user-backfill");
    assert.equal(rows[0].wording_version, "operator-backfill-2026-10-30");
    assert.equal(rows[0].locale, "und");
    assert.equal(rows[0].verified_at, 1);
    assert.equal(rows[0].completed_at, null);
    assert.equal(rows[0].ip, null);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { db.close(); }
});

it("requeues old deliveries for the user tag while preserving signup evidence", () => {
  const db = previousDatabase();
  try {
    for (const id of ["completed", "pending"]) {
      owner(db, id);
      ship(db, id, id);
      db.prepare(`INSERT INTO product_email_signups (email, principal_id, request_id, wording_version,
        locale, requested_at, verified_at, due_at, attempts, completed_at)
        VALUES (?, ?, ?, 'ship-product-updates-2026-10-26', 'es', 123, 1, 1, 2, ?)`)
        .run(`${id}@example.com`, id, id, id === "completed" ? 456 : null);
    }
    db.exec(source(migration));
    const rows = db.prepare("SELECT * FROM product_email_signups").all();
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.request_id, `${row.principal_id}:user`);
      assert.equal(row.source, "ship-signup");
      assert.equal(row.wording_version, "ship-product-updates-2026-10-26");
      assert.equal(row.locale, "es");
      assert.equal(row.requested_at, 123);
      assert.equal(row.completed_at, null);
      assert.equal(row.attempts, 0);
    }
  } finally { db.close(); }
});
