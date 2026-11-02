import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { createManifest, importSql, recipientQuery } from "./product-email-backfill.mjs";

const migrations = new URL("../workers/installations/migrations/", import.meta.url);
const source = (name) => readFileSync(new URL(name, migrations), "utf8");
function database(stop = "9999") {
  const db = new DatabaseSync(":memory:");
  for (const name of readdirSync(migrations).filter((name) => name.endsWith(".sql") && name < stop).sort()) db.exec(source(name));
  return db;
}
function owner(db, id, { state = "active", verified = 1, created = 1 } = {}) {
  db.prepare(`INSERT INTO principals (id,primary_email,primary_email_normalized,display_name,email_verified_at,state,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(id, `${id}@example.com`, `${id}@example.com`, id, verified, state, created, created);
}
function ship(db, id, principal, state = "active", created = 1) {
  db.prepare(`INSERT INTO installations (id,owner_principal_id,handle,canonical_origin,state,provision_version,created_at)
    VALUES (?,?,?,?,?,1,?)`).run(id, principal, id, `https://${id}.example.com`, state, created);
}
function preview(db) { return createManifest("test-database", false, 100, db.prepare(recipientQuery(100)).all()); }

it("holds automatic backfills and replay requests from the immutable earlier migration", () => {
  const db = database("0035");
  try {
    owner(db, "existing"); ship(db, "existing", "existing");
    owner(db, "other"); ship(db, "other", "other");
    db.exec(`INSERT INTO product_email_signups (email,principal_id,request_id,wording_version,locale,requested_at,verified_at,due_at,attempts,completed_at)
      VALUES ('existing@example.com','existing','request','actual-wording','es',12,1,15,2,20)`);
    db.exec(source("0035_product_email_users.sql"));
    db.exec(source("0036_product_email_consent.sql"));
    const existing = db.prepare("SELECT * FROM product_email_signups WHERE principal_id='existing'").get();
    assert.equal(existing.wording_version, 'actual-wording');
    assert.equal(existing.requested_at, 12);
    assert.equal(existing.consented_at, 12);
    assert.equal(existing.consent_basis, 'unconfirmed-legacy-replay');
    assert.equal(db.prepare("SELECT consent_basis FROM product_email_signups WHERE principal_id='other'").get().consent_basis, 'unconfirmed-legacy-backfill');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM product_email_signups WHERE consent_basis IN ('signup-checkbox','operator-confirmed-existing-opt-ins')").get().n, 0);
    const manifest = preview(db);
    db.exec(importSql(manifest, 200));
    const approved = db.prepare("SELECT * FROM product_email_signups WHERE principal_id='existing'").get();
    assert.equal(approved.consent_basis, 'signup-checkbox');
    assert.equal(approved.wording_version, 'actual-wording');
    assert.equal(approved.locale, 'es');
    assert.equal(approved.consented_at, 12);
    assert.equal(approved.import_id, manifest.importId);
  } finally { db.close(); }
});

it("previews one row per eligible historical owner and writes nothing", () => {
  const db = database();
  try {
    owner(db, "eligible"); ship(db, "first", "eligible"); ship(db, "second", "eligible");
    owner(db, "disabled", { state: "disabled" }); ship(db, "disabled", "disabled");
    owner(db, "unverified", { verified: null }); ship(db, "unverified", "unverified");
    owner(db, "future", { created: 101 }); ship(db, "future", "future");
    owner(db, "later-verified", { verified: 101 }); ship(db, "later-verified", "later-verified");
    owner(db, "future-ship"); ship(db, "future-ship", "future-ship", "active", 101);
    owner(db, "no-ship");
    for (const state of ["reserved", "provisioning", "restricted", "cancelled", "retained", "deleting", "deleted"]) {
      owner(db, state); ship(db, state, state, state);
    }
    const manifest = preview(db);
    assert.deepEqual(manifest.recipients.map((row) => row.id), ["eligible"]);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM product_email_signups").get().n, 0);
    db.exec(importSql(manifest, 200));
    const row = db.prepare("SELECT * FROM product_email_signups").get();
    assert.equal(row.consent_basis, "operator-confirmed-existing-opt-ins");
    assert.equal(row.consented_at, null);
    assert.equal(row.wording_version, "unknown");
    assert.equal(row.requested_at, 200);
    assert.equal(row.import_id, manifest.importId);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { db.close(); }
});

it("rechecks current eligibility, never includes later owners, and preserves completed imports on replay", () => {
  const db = database();
  try {
    for (const id of ["keep", "disabled", "changed", "unverified", "restricted"]) { owner(db, id); ship(db, id, id); }
    const manifest = preview(db);
    db.exec("UPDATE principals SET state='disabled' WHERE id='disabled'");
    db.exec("UPDATE principals SET primary_email_normalized='new@example.com' WHERE id='changed'");
    db.exec("UPDATE principals SET email_verified_at=NULL WHERE id='unverified'");
    db.exec("UPDATE installations SET state='restricted' WHERE id='restricted'");
    owner(db, "late"); ship(db, "late", "late");
    db.exec(importSql(manifest, 200));
    assert.deepEqual(db.prepare("SELECT principal_id FROM product_email_signups").all().map((row) => row.principal_id), ["keep"]);
    db.exec("UPDATE product_email_signups SET completed_at=250,attempts=2");
    const original = db.prepare("SELECT * FROM product_email_signups").get();
    db.exec(importSql(manifest, 300));
    assert.deepEqual(db.prepare("SELECT * FROM product_email_signups").get(), original);
    db.exec(importSql(preview(db), 400));
    assert.deepEqual(db.prepare("SELECT * FROM product_email_signups WHERE principal_id='keep'").get(), original);
  } finally { db.close(); }
});

it("holds earlier preview backfills until an operator confirms the import and preserves real signup evidence", () => {
  const db = database("0036");
  try {
    for (const id of ["legacy", "completed", "checkbox"]) {
      owner(db, id); ship(db, id, id);
      db.prepare(`INSERT INTO product_email_signups (email,principal_id,request_id,wording_version,locale,requested_at,verified_at,due_at,source,completed_at)
        VALUES (?,?,?,'old-wording','es',12,1,12,?,?)`).run(`${id}@example.com`, id, id,
        id === "checkbox" ? "ship-signup" : "ship-existing-user-backfill", id === "completed" ? 20 : null);
    }
    db.exec(source("0036_product_email_consent.sql"));
    assert.equal(db.prepare("SELECT consent_basis FROM product_email_signups WHERE principal_id='legacy'").get().consent_basis, "unconfirmed-legacy-backfill");
    const completed = db.prepare("SELECT * FROM product_email_signups WHERE principal_id='completed'").get();
    const checkbox = db.prepare("SELECT * FROM product_email_signups WHERE principal_id='checkbox'").get();
    db.exec(importSql(preview(db), 200));
    assert.equal(db.prepare("SELECT consent_basis FROM product_email_signups WHERE principal_id='legacy'").get().consent_basis, "operator-confirmed-existing-opt-ins");
    assert.deepEqual(db.prepare("SELECT * FROM product_email_signups WHERE principal_id='checkbox'").get(), checkbox);
    assert.deepEqual(db.prepare("SELECT * FROM product_email_signups WHERE principal_id='completed'").get(), completed);
  } finally { db.close(); }
});

it("rejects changed manifests, duplicate recipients and future cutoffs", () => {
  const db = database();
  try {
    owner(db, "one"); ship(db, "one", "one");
    const manifest = preview(db);
    assert.throws(() => importSql({ ...manifest, database: "other" }), /Manifest changed/);
    assert.throws(() => importSql(createManifest("test", false, 100, [...manifest.recipients, ...manifest.recipients])), /duplicate/);
    assert.throws(() => recipientQuery(Date.now() + 60_000), /past timestamp/);
  } finally { db.close(); }
});
