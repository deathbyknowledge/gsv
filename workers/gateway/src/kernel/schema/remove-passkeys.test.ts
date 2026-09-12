import { describe, expect, it } from "vitest";
import { hashPassword, makeShadowEntry } from "../../auth/shadow";
import { listAppliedSqlMigrations, runSqlMigrations } from "../../schema/runner";
import { runWithRealKernelSql } from "../../test-support/real-kernel-sql";
import { AuthStore } from "../auth-store";
import { KERNEL_MIGRATIONS, KERNEL_SCHEMA_COMPONENT, runKernelSqlMigrations } from "./migrations";

describe("retiring passkey storage", () => {
  it("upgrades v48 without changing passwords, token credentials or recovery state", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      await storage.deleteAll();
      runSqlMigrations(storage, KERNEL_SCHEMA_COMPONENT, KERNEL_MIGRATIONS.filter((migration) => migration.id < 49));
      const auth = new AuthStore(sql);
      await auth.bootstrap();
      auth.setShadow(makeShadowEntry("root", await hashPassword("root-password")));
      auth.addUser({ uid: 1000, gid: 100, username: "person", home: "/home/person", gecos: "", shell: "/bin/init" });
      auth.setShadow(makeShadowEntry("person", await hashPassword("person-password")));
      const human = await auth.issueToken({ uid: 1000, kind: "human", label: "existing browser" });
      const machine = await auth.issueToken({ uid: 1000, kind: "machine", peerId: "existing-machine" });
      sql.exec("INSERT INTO account_access (uid, credential_epoch) VALUES (0, 3), (1000, 2)");
      sql.exec("INSERT INTO account_owner_links (id, secret_hash, credential_epoch, expires_at) VALUES ('owner', 'owner-hash', 3, ?)", Date.now() + 60_000);
      sql.exec(`INSERT INTO account_recovery_claims (id, purpose, secret_hash, credential_epoch, expires_at)
        VALUES ('recover', 'root-password-reset', 'recovery-hash', 3, ?)`, Date.now() + 60_000);
      sql.exec("INSERT INTO account_passkey_users (uid, user_handle) VALUES (1000, 'retired-user')");
      sql.exec(`INSERT INTO account_passkeys (id, uid, public_key, counter, transports_json, device_type, backed_up, label, created_at)
        VALUES ('retired-key', 1000, ?, 1, '[]', 'singleDevice', 0, 'retired', 1)`, new Uint8Array([1, 2, 3]));
      sql.exec(`INSERT INTO account_passkey_challenges (id, uid, purpose, challenge, origin, rp_id, credential_epoch, label, expires_at)
        VALUES ('retired-challenge', 1000, 'authenticate', 'challenge', 'https://space.example.com', 'space.example.com', 2, '', ?)`, Date.now() + 60_000);
      const preservedCapabilities = [
        { gid: 0, capability: "*" },
        { gid: 100, capability: "account.*" },
        { gid: 100, capability: "account.list" },
        { gid: 100, capability: "sys.token.create" },
        { gid: 101, capability: "fs.*" },
      ];
      for (const { gid, capability } of preservedCapabilities) {
        sql.exec("INSERT INTO group_capabilities (gid, capability) VALUES (?, ?)", gid, capability);
      }
      for (const capability of [
        "account.passkey.register.begin",
        "account.passkey.register.finish",
        "account.passkey.authenticate.begin",
        "account.passkey.authenticate.finish",
        "account.passkey.list",
        "account.passkey.revoke",
      ]) {
        sql.exec("INSERT INTO group_capabilities (gid, capability) VALUES (100, ?)", capability);
      }
      sql.exec("INSERT INTO group_capabilities (gid, capability) VALUES (200, 'account.passkey.*')");
      const tables = ["passwd", "shadow", "auth_tokens", "account_access", "account_owner_links", "account_recovery_claims"];
      const snapshot = () => tables.map((table) => sql.exec(`SELECT * FROM ${table}`).toArray());
      const before = snapshot();
      const applied = listAppliedSqlMigrations(storage, KERNEL_SCHEMA_COMPONENT);

      runKernelSqlMigrations(storage);
      runKernelSqlMigrations(storage);

      expect(snapshot()).toEqual(before);
      expect(sql.exec("SELECT gid, capability FROM group_capabilities ORDER BY gid, capability").toArray()).toEqual(preservedCapabilities);
      expect(listAppliedSqlMigrations(storage, KERNEL_SCHEMA_COMPONENT).filter((migration) => migration.id < 49)).toEqual(applied);
      expect(sql.exec("SELECT name FROM sqlite_master WHERE name LIKE 'account_passkey%'").toArray()).toEqual([]);
      expect(await auth.authenticate("root", "root-password")).toMatchObject({ ok: true });
      expect(await auth.authenticate("person", "person-password")).toMatchObject({ ok: true });
      expect(await auth.authenticateToken("person", human.token)).toMatchObject({ ok: true });
      expect(await auth.authenticatePeerToken("person", machine.token)).toMatchObject({ ok: true, kind: "machine", peerId: "existing-machine" });
      expect(auth.credentialEpoch(0)).toBe(3);
      expect(auth.credentialEpoch(1000)).toBe(2);
    });
  });

  it("starts a fresh Kernel without passkey tables", async () => {
    await runWithRealKernelSql((sql) => {
      expect(sql.exec("SELECT name FROM sqlite_master WHERE name LIKE 'account_passkey%'").toArray()).toEqual([]);
      expect(listAppliedSqlMigrations(sql, KERNEL_SCHEMA_COMPONENT).at(-1)).toMatchObject({ id: 49, name: "remove_account_passkeys" });
    });
  });
});
