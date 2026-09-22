import { describe, expect, it } from "vitest";
import { runSqlMigrations } from "../../schema/runner";
import { runWithRealKernelSql } from "../../test-support/real-kernel-sql";
import { FederationStore } from "../federation-store";
import { KERNEL_MIGRATIONS, KERNEL_SCHEMA_COMPONENT, runKernelSqlMigrations } from "./migrations";

describe("request exchange upgrade", () => {
  it("preserves old request states without inventing a remote confirmation", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      await storage.deleteAll();
      runSqlMigrations(storage, KERNEL_SCHEMA_COMPONENT, KERNEL_MIGRATIONS.filter((migration) => migration.id < 53));
      sql.exec(`INSERT INTO federation_requests (
        request_id, contact_id, contact_generation, direction, kind, title, state, revision, created_at, updated_at
      ) VALUES ('request:old', 'contact:old', 'generation:old', 'outgoing', 'task', 'Old work', 'completed', 3, 1, 2)`);
      runKernelSqlMigrations(storage);
      runKernelSqlMigrations(storage);
      expect(new FederationStore(storage).request("request:old")).toMatchObject({
        state: "completed", revision: 3, createdAtMs: 1, updatedAtMs: 2,
        exchange: { state: "unconfirmed" },
      });
    });
  });
});
