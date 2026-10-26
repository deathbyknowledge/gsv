import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";

const directory = new URL("../../workers/installations/migrations/", import.meta.url);
const source = (name: string) => readFileSync(new URL(name, directory), "utf8");
const originalName = "0028_username_policy.sql";
const cleanupName = "0029_remove_username_policy_starters.sql";
const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function seededDatabase() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  for (const name of readdirSync(directory).filter((name) => name.endsWith(".sql") && name <= originalName).sort()) {
    db.exec(source(name));
  }
  return db;
}

it("preserves the exact username migration already applied by previews", () => {
  expect(createHash("sha256").update(source(originalName)).digest("hex"))
    .toBe("70579061f38976dc038fb16737f2c79ce34c15a7aebe40b1a603f0dfbaf1b7b6");
});

it("finishes a fresh installation with empty username policy lists", () => {
  const db = seededDatabase();
  expect(db.prepare("SELECT COUNT(*) AS count FROM username_policy").get()?.count).toBeGreaterThan(0);
  db.exec(source(cleanupName));
  expect(db.prepare("SELECT * FROM username_policy").all()).toEqual([]);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});

it("removes only unchanged starter rows when upgrading an unaudited policy", () => {
  const db = seededDatabase();
  db.exec(`
    UPDATE username_policy SET entry = 'SHIP' WHERE kind = 'reserved' AND normalized_handle = 'ship';
    INSERT INTO username_policy (kind, normalized_handle, entry) VALUES
      ('reserved', 'customreserved', 'custom-reserved'),
      ('blocked', 'customblocked', 'custom-blocked'),
      ('blocked', 'ship', 'ship');
  `);
  db.exec(source(cleanupName));
  expect(db.prepare("SELECT kind, entry FROM username_policy ORDER BY kind, normalized_handle").all()).toEqual([
    { kind: "blocked", entry: "custom-blocked" },
    { kind: "blocked", entry: "ship" },
    { kind: "reserved", entry: "custom-reserved" },
    { kind: "reserved", entry: "SHIP" },
  ]);
});

it.each(["completed", "pending"])("preserves the whole policy after a %s operator save", (outcome) => {
  const db = seededDatabase();
  db.prepare(`INSERT INTO operator_audit_events (id, at, actor, action, outcome)
    VALUES ('policy-save', 1, 'operator', 'signup.username-policy.update', ?)`).run(outcome);
  const before = db.prepare("SELECT * FROM username_policy ORDER BY kind, normalized_handle").all();
  db.exec(source(cleanupName));
  expect(db.prepare("SELECT * FROM username_policy ORDER BY kind, normalized_handle").all()).toEqual(before);
});

it("retires starter rows after a failed operator save", () => {
  const db = seededDatabase();
  db.exec(`INSERT INTO operator_audit_events (id, at, actor, action, outcome)
    VALUES ('policy-save', 1, 'operator', 'signup.username-policy.update', 'error')`);
  db.exec(source(cleanupName));
  expect(db.prepare("SELECT * FROM username_policy").all()).toEqual([]);
});
