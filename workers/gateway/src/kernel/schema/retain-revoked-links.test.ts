import { describe, expect, it } from "vitest";
import { listAppliedSqlMigrations, runSqlMigrations } from "../../schema/runner";
import { runWithRealKernelSql } from "../../test-support/real-kernel-sql";
import { IdentityLinkStore } from "../identity-links";
import { KERNEL_MIGRATIONS, KERNEL_SCHEMA_COMPONENT, runKernelSqlMigrations } from "./migrations";

describe("retaining revoked identity links", () => {
  it("preserves v49 links and migration receipts while separating active authority from cleanup state", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      await storage.deleteAll();
      runSqlMigrations(storage, KERNEL_SCHEMA_COMPONENT, KERNEL_MIGRATIONS.filter((migration) => migration.id < 50));
      const migrations = listAppliedSqlMigrations(storage, KERNEL_SCHEMA_COMPONENT);
      sql.exec(`INSERT INTO identity_links (adapter, account_id, actor_id, uid, created_at, linked_by_uid, metadata_json)
        VALUES ('telegram', 'managed', 'existing', 1000, 123, 1000, ?)`, JSON.stringify({ managed: true, surfaceId: "existing", routeGeneration: "existing-generation" }));
      runKernelSqlMigrations(storage);
      runKernelSqlMigrations(storage);
      expect(listAppliedSqlMigrations(storage, KERNEL_SCHEMA_COMPONENT).filter((migration) => migration.id < 50)).toEqual(migrations);
      const links = new IdentityLinkStore(sql);
      const preserved = links.get("telegram", "managed", "existing");
      expect(preserved).toMatchObject({ uid: 1000, createdAt: 123, metadata: { routeGeneration: "existing-generation" } });
      expect(links.resolveUid("telegram", "managed", "existing")).toBe(1000);
      expect(links.list()).toEqual([preserved]);

      sql.exec("UPDATE identity_links SET revoked_at = 456 WHERE uid = 1000");
      expect(links.get("telegram", "managed", "existing")).toBeNull();
      expect(links.resolveUid("telegram", "managed", "existing")).toBeNull();
      expect(links.list()).toEqual([]);
      expect(links.list(1000)).toEqual([]);
      expect(links.listByAccount("telegram", "managed")).toEqual([]);
      expect(links.bindSurfaceIfMissing("telegram", "managed", "existing", { kind: "dm", id: "another" })).toBeNull();
      expect(links.getForCleanup("telegram", "managed", "existing")).toEqual(preserved);
      expect(links.listForCleanup(1000)).toEqual([preserved]);

      expect(() => links.link("telegram", "managed", "existing", 1001, 0)).toThrow("Disconnect the revoked messenger identity");
      expect(links.getForCleanup("telegram", "managed", "existing")).toEqual(preserved);
      links.unlink("telegram", "managed", "existing");
      links.link("telegram", "managed", "existing", 1001, 1001, { managed: true, surfaceId: "existing", routeGeneration: "successor" });
      expect(links.get("telegram", "managed", "existing")).toMatchObject({ uid: 1001, metadata: { routeGeneration: "successor" } });
      expect(links.listForCleanup(1000)).toEqual([]);
    });
  });
});
