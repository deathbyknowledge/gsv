import { describe, expect, it } from "vitest";
import { runSqlMigrations } from "../../schema/runner";
import { runWithRealKernelSql } from "../../test-support/real-kernel-sql";
import { KERNEL_MIGRATIONS, KERNEL_SCHEMA_COMPONENT, runKernelSqlMigrations } from "./migrations";

describe("memory review task migration", () => {
  it("removes the memory review poll, leaving other tasks", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      await storage.deleteAll();
      runSqlMigrations(storage, KERNEL_SCHEMA_COMPONENT, KERNEL_MIGRATIONS.filter((migration) => migration.id < 99));
      const insertTask = "INSERT INTO cf_agents_schedules (id, callback, payload, type, time) VALUES (?, ?, ?, 'scheduled', 1)";
      sql.exec(insertTask, "task:review", "onMemoryReview", JSON.stringify(1000));
      sql.exec(insertTask, "task:wake", "onResponsibilityWake", JSON.stringify({ ownerUid: 1000, generation: 1 }));

      runKernelSqlMigrations(storage);
      runKernelSqlMigrations(storage);

      expect(sql.exec<{ id: string }>("SELECT id FROM cf_agents_schedules ORDER BY id").toArray()).toEqual([{ id: "task:wake" }]);
    });
  });
});
