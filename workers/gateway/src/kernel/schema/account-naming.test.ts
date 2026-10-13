import { describe, expect, it } from "vitest";
import { runSqlMigrations } from "../../schema/runner";
import { runWithRealKernelSql } from "../../test-support/real-kernel-sql";
import { KERNEL_MIGRATIONS, KERNEL_SCHEMA_COMPONENT, runKernelSqlMigrations } from "./migrations";

describe("account naming upgrade", () => {
  it.each([true, false])("adds naming only to an existing personal account grant (%s)", async (mayList) => {
    await runWithRealKernelSql(async (sql, storage) => {
      await storage.deleteAll();
      runSqlMigrations(storage, KERNEL_SCHEMA_COMPONENT, KERNEL_MIGRATIONS.filter((migration) => migration.id < 70));
      sql.exec("INSERT INTO group_capabilities (gid, capability) VALUES (2000, 'account.list')");
      if (mayList) sql.exec("INSERT INTO group_capabilities (gid, capability) VALUES (100, 'account.list')");
      runKernelSqlMigrations(storage);
      runKernelSqlMigrations(storage);
      expect(sql.exec<{ gid: number }>("SELECT gid FROM group_capabilities WHERE capability = 'account.update'").toArray())
        .toEqual(mayList ? [{ gid: 100 }] : []);
    });
  });
});
