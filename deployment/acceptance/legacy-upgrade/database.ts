import type { DatabaseProps } from "alchemy/Cloudflare/D1";
import { join } from "node:path";
import type { UpgradePhase } from "./plan.ts";

export function legacyDatabaseProps(name: string, artifactsDirectory: string, phase: UpgradePhase): DatabaseProps {
  if (phase === "legacy") {
    return { name, importFiles: [join(artifactsDirectory, "legacy/migrations/database.seed.sql")] };
  }
  return { name };
}

/** Preserve the historical ledger instead of adopting it into Alchemy's current format. */
export function legacyDatabaseSeed(migrations: readonly { name: string; sql: string }[]): string {
  return [
    "CREATE TABLE d1_migrations (id TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);",
    ...migrations.toSorted((a, b) => a.name.localeCompare(b.name)).map(({ name, sql }, index) =>
      `${sql.trim()}\n;\nINSERT INTO d1_migrations (id, name, applied_at) VALUES ('${String(index + 1).padStart(5, "0")}', '${name.replaceAll("'", "''")}', datetime('now'));`),
  ].join("\n\n") + "\n";
}
