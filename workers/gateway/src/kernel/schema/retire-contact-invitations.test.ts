import { describe, expect, it } from "vitest";
import { runSqlMigrations } from "../../schema/runner";
import { runWithRealKernelSql } from "../../test-support/real-kernel-sql";
import { KERNEL_MIGRATIONS, KERNEL_SCHEMA_COMPONENT, runKernelSqlMigrations } from "./migrations";

describe("contact invitations migration", () => {
  it("drops invitations and their notices, and closes profiles that took only invited people", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      await storage.deleteAll();
      runSqlMigrations(storage, KERNEL_SCHEMA_COMPONENT, KERNEL_MIGRATIONS.filter((migration) => migration.id < 98));
      const notice = (key: string, topic: string) => sql.exec(
        `INSERT INTO owner_notices (notice_key, owner_uid, topic, subject_json, pending_count, state, next_attempt_at, created_at, updated_at)
         VALUES (?, 1000, ?, '{}', 1, 'pending', 0, 0, 0)`, key, topic);
      notice("accepted", "contact.invite.accepted");
      notice("request", "contact.request");
      const rule = (kind: string) => sql.exec(
        "INSERT INTO notice_rules (owner_uid, kind, notify, ship, changed_by, updated_at) VALUES (1000, ?, 'none', 'none', 'person', 0)", kind);
      rule("contact.invite.accepted");
      rule("contact.message");
      const profile = (uid: number, contactPolicy: string) => sql.exec(
        "INSERT INTO social_profiles (owner_uid, revision, draft_json) VALUES (?, 3, ?)",
        uid, JSON.stringify({ displayName: "ada", about: "", contactPolicy }));
      profile(1000, "invitation");
      profile(1001, "requests");

      runKernelSqlMigrations(storage);
      runKernelSqlMigrations(storage);

      const tables = sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'federation_%'")
        .toArray().map((row) => row.name);
      expect(tables).not.toContain("federation_invites");
      expect(tables).not.toContain("federation_pairing_attempts");
      expect(sql.exec("SELECT notice_key FROM owner_notices").toArray()).toEqual([{ notice_key: "request" }]);
      expect(sql.exec("SELECT kind FROM notice_rules").toArray()).toEqual([{ kind: "contact.message" }]);
      expect(sql.exec<{ owner_uid: number; revision: number; draft_json: string }>(
        "SELECT owner_uid, revision, draft_json FROM social_profiles ORDER BY owner_uid",
      ).toArray().map((row) => ({ ...row, draft_json: JSON.parse(row.draft_json) }))).toEqual([
        { owner_uid: 1000, revision: 3, draft_json: { displayName: "ada", about: "", contactPolicy: "closed" } },
        { owner_uid: 1001, revision: 3, draft_json: { displayName: "ada", about: "", contactPolicy: "requests" } },
      ]);
    });
  });
});
