import { describe, expect, it } from "vitest";
import { runSqlMigrations } from "../../schema/runner";
import { runWithRealKernelSql } from "../../test-support/real-kernel-sql";
import { DidDocumentStore } from "../ships/did-directory";
import { KERNEL_MIGRATIONS, KERNEL_SCHEMA_COMPONENT, runKernelSqlMigrations } from "./migrations";

describe("deactivated DIDs migration", () => {
  it("keeps the cached documents and lets the cache remember a deactivated DID", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      await storage.deleteAll();
      runSqlMigrations(storage, KERNEL_SCHEMA_COMPONENT, KERNEL_MIGRATIONS.filter((migration) => migration.id < 78));
      const document = JSON.stringify({ did: "did:plc:alice", handle: "alice.ship.test" });
      sql.exec("INSERT INTO did_documents (did, resolved_json, resolved_at, used_at) VALUES (?, ?, ?, ?)", "did:plc:alice", document, 10, 20);

      runKernelSqlMigrations(storage);
      runKernelSqlMigrations(storage);

      expect(sql.exec("SELECT * FROM did_documents").toArray()).toEqual([
        { did: "did:plc:alice", resolved_json: document, resolved_at: 10, used_at: 20 },
      ]);
      const cache = new DidDocumentStore(sql);
      cache.deactivate("did:plc:bob", 30);
      expect(cache.deactivated(["did:plc:alice", "did:plc:bob"])).toEqual(new Set(["did:plc:bob"]));
      expect(cache.get("did:plc:bob", 40)).toEqual({ resolved: null, resolvedAtMs: 30 });
    });
  });
});
