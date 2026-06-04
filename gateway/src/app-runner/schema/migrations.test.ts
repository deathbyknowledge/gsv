import { describe, expect, it } from "vitest";
import { APP_RUNNER_MIGRATIONS, APP_RUNNER_SCHEMA_COMPONENT } from "./migrations";

function normalizedStatements(): string[] {
  return APP_RUNNER_MIGRATIONS.flatMap((migration) => migration.statements)
    .map((statement) => statement.trim().replace(/\s+/g, " "));
}

function createdTables(): string[] {
  return normalizedStatements()
    .map((statement) => statement.match(/^CREATE TABLE IF NOT EXISTS ([a-z_]+)/)?.[1])
    .filter((name): name is string => Boolean(name));
}

function createdIndexes(): string[] {
  return normalizedStatements()
    .map((statement) => statement.match(/^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS ([a-z_]+)/)?.[1])
    .filter((name): name is string => Boolean(name));
}

function createTableStatement(name: string): string {
  const statement = normalizedStatements().find((candidate) => (
    candidate.startsWith(`CREATE TABLE IF NOT EXISTS ${name} `)
  ));
  if (!statement) {
    throw new Error(`missing CREATE TABLE statement for ${name}`);
  }
  return statement;
}

describe("app runner schema migrations", () => {
  it("starts the app-runner component at a v1 baseline", () => {
    expect(APP_RUNNER_SCHEMA_COMPONENT).toBe("app-runner");
    expect(APP_RUNNER_MIGRATIONS).toHaveLength(1);
    expect(APP_RUNNER_MIGRATIONS[0]).toMatchObject({
      id: 1,
      name: "initial_app_runner_schema",
    });
  });

  it("creates the current app runner table set", () => {
    expect(createdTables()).toEqual(["app_rpc_schedules"]);
  });

  it("keeps daemon schedules on the current runtime schema", () => {
    const schedules = createTableStatement("app_rpc_schedules");

    expect(schedules).toContain("schedule_key TEXT PRIMARY KEY");
    expect(schedules).toContain("rpc_method TEXT NOT NULL");
    expect(schedules).toContain("version INTEGER NOT NULL DEFAULT 1");
    expect(schedules).toContain("next_run_at INTEGER");
    expect(schedules).toContain("last_duration_ms INTEGER");
  });

  it("includes current indexes owned by the app runner", () => {
    expect(createdIndexes()).toEqual(["idx_app_rpc_schedules_due"]);
  });
});
