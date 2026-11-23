import { describe, expect, it } from "vitest";
import { runSqlMigrations } from "../../schema/runner";
import { runWithRealKernelSql } from "../../test-support/real-kernel-sql";
import { KERNEL_MIGRATIONS, KERNEL_SCHEMA_COMPONENT, runKernelSqlMigrations } from "./migrations";

const avatar = (cid: string) => ({ $type: "blob", ref: { $link: cid }, mimeType: "image/png", size: 3 });

describe("public profile records migration", () => {
  it("keeps each published record as the profile and drops drafts, unused pictures and setup's publish choice", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      await storage.deleteAll();
      runSqlMigrations(storage, KERNEL_SCHEMA_COMPONENT, KERNEL_MIGRATIONS.filter((migration) => migration.id < 99));
      const published = { $type: "space.ship.profile", displayName: "ada", about: "Public words.", contactPolicy: "requests", avatar: avatar("bafkpublished") };
      const mirror = { $type: "app.bsky.actor.profile", displayName: "ada" };
      // Published, with later changes that never were.
      sql.exec(`INSERT INTO social_profiles (owner_uid, revision, draft_json, draft_avatar_cid, published_revision, published_json, published_cid, mirror_json)
        VALUES (1000, 5, ?, 'bafkdraft', 3, ?, 'bafyrecord', ?)`,
      JSON.stringify({ displayName: "ada", about: "Private words.", contactPolicy: "closed" }), JSON.stringify(published), JSON.stringify(mirror));
      // Never published.
      sql.exec("INSERT INTO social_profiles (owner_uid, revision, draft_json, draft_avatar_cid) VALUES (1001, 2, ?, 'bafkunpublished')",
        JSON.stringify({ displayName: "bo", about: "Kept to myself.", contactPolicy: "requests" }));
      // Published before profiles were records: its repository doesn't hold it yet.
      const signed = { $type: "space.ship.profile", displayName: "cy", contactPolicy: "closed" };
      sql.exec("INSERT INTO social_profiles (owner_uid, revision, draft_json, published_revision, published_json) VALUES (1002, 1, ?, 1, ?)",
        JSON.stringify({ displayName: "cy", about: "", contactPolicy: "closed" }), JSON.stringify(signed));
      for (const cid of ["bafkpublished", "bafkdraft", "bafkunpublished"]) {
        sql.exec("INSERT INTO social_profile_avatars (cid, mime_type, bytes) VALUES (?, 'image/png', ?)", cid, new Uint8Array([1, 2, 3]).buffer);
      }
      sql.exec("INSERT INTO config_kv (key, value) VALUES ('users/1001/profile/publish_chosen', '1'), ('users/1001/locale/language', 'en')");

      runKernelSqlMigrations(storage);
      runKernelSqlMigrations(storage);

      expect(sql.exec<{ owner_uid: number; revision: number; record_json: string; record_cid: string | null; mirror_json: string | null }>(
        "SELECT owner_uid, revision, record_json, record_cid, mirror_json FROM social_profiles ORDER BY owner_uid",
      ).toArray().map((row) => ({ ...row, record_json: JSON.parse(row.record_json), mirror_json: row.mirror_json && JSON.parse(row.mirror_json) }))).toEqual([
        { owner_uid: 1000, revision: 5, record_json: published, record_cid: "bafyrecord", mirror_json: mirror },
        { owner_uid: 1002, revision: 1, record_json: signed, record_cid: null, mirror_json: null },
      ]);
      expect(sql.exec("SELECT cid FROM social_profile_avatars").toArray()).toEqual([{ cid: "bafkpublished" }]);
      expect(sql.exec("SELECT key FROM config_kv WHERE key LIKE 'users/1001/%' ORDER BY key").toArray()).toEqual([{ key: "users/1001/locale/language" }]);
    });
  });
});
