import { describe, expect, it } from "vitest";
import { runSqlMigrations } from "../../schema/runner";
import { runWithRealKernelSql } from "../../test-support/real-kernel-sql";
import { ConfigStore, SYSTEM_CONFIG_DEFAULTS } from "../config";
import { KERNEL_MIGRATIONS, KERNEL_SCHEMA_COMPONENT, runKernelSqlMigrations } from "./migrations";

describe("numbered system context retirement", () => {
  it("drops saved files under the retired names and keeps everything else", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      await storage.deleteAll();
      // v070 left an empty 02-interaction.md beside a custom 01-gsv.md.
      runSqlMigrations(storage, KERNEL_SCHEMA_COMPONENT, KERNEL_MIGRATIONS.filter((migration) => migration.id < 70));
      const config = new ConfigStore(sql);
      config.set("config/ai/context.d/01-gsv.md", "Custom world.\n");
      config.set("config/ai/context.d/40-house-rules.md", "An operator's own file.\n");
      config.set("config/ai/reasoning", "high");

      runKernelSqlMigrations(storage);
      runKernelSqlMigrations(storage);

      expect(config.listExplicit("config/ai/context.d").map(({ key }) => key)).toEqual([
        "config/ai/context.d/40-house-rules.md",
      ]);
      expect(config.get("config/ai/reasoning")).toBe("high");
      expect(config.list("config/ai/context.d").map(({ key }) => key)).toEqual([
        "config/ai/context.d/40-house-rules.md",
        "config/ai/context.d/environment.md",
      ]);
      expect(config.get("config/ai/context.d/environment.md")).toBe(SYSTEM_CONFIG_DEFAULTS["config/ai/context.d/environment.md"]);
    });
  });
});
