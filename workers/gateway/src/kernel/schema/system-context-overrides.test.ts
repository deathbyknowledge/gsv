import { describe, expect, it } from "vitest";
import { runSqlMigrations } from "../../schema/runner";
import { runWithRealKernelSql } from "../../test-support/real-kernel-sql";
import { ConfigStore, SYSTEM_CONFIG_DEFAULTS } from "../config";
import { KERNEL_MIGRATIONS, KERNEL_SCHEMA_COMPONENT, runKernelSqlMigrations } from "./migrations";

const WORLD_KEY = "config/ai/context.d/01-gsv.md";
const INTERACTION_KEY = "config/ai/context.d/02-interaction.md";

describe("system context override migration", () => {
  it.each([
    { name: "custom combined context", world: "  Custom world and interaction.\n", interaction: null, expectedInteraction: "" },
    { name: "explicitly disabled combined context", world: "", interaction: null, expectedInteraction: "" },
    { name: "existing interaction override", world: "Custom world.\n", interaction: "Custom interaction.\n", expectedInteraction: "Custom interaction.\n" },
    { name: "explicitly disabled interaction", world: "Custom world.\n", interaction: "", expectedInteraction: "" },
    { name: "fresh defaults", world: null, interaction: null, expectedInteraction: null },
  ])("preserves $name across upgrade and restart", async ({ world, interaction, expectedInteraction }) => {
    await runWithRealKernelSql(async (sql, storage) => {
      await storage.deleteAll();
      runSqlMigrations(storage, KERNEL_SCHEMA_COMPONENT, KERNEL_MIGRATIONS.filter((migration) => migration.id < 70));
      const config = new ConfigStore(sql);
      if (world !== null) config.set(WORLD_KEY, world);
      if (interaction !== null) config.set(INTERACTION_KEY, interaction);

      runKernelSqlMigrations(storage);
      runKernelSqlMigrations(storage);

      expect(config.getExplicit(WORLD_KEY)).toBe(world);
      expect(config.getExplicit(INTERACTION_KEY)).toBe(expectedInteraction);
      expect(config.get(WORLD_KEY)).toBe(world ?? SYSTEM_CONFIG_DEFAULTS[WORLD_KEY]);
      expect(config.get(INTERACTION_KEY)).toBe(expectedInteraction ?? SYSTEM_CONFIG_DEFAULTS[INTERACTION_KEY]);

      config.delete(INTERACTION_KEY);
      runKernelSqlMigrations(storage);
      expect(config.getExplicit(INTERACTION_KEY)).toBeNull();
      expect(config.get(INTERACTION_KEY)).toBe(SYSTEM_CONFIG_DEFAULTS[INTERACTION_KEY]);
    });
  });
});
