import { describe, expect, it } from "vitest";
import {
  listAppliedSqlMigrations,
  runSqlMigrations,
  type AppliedSqlMigration,
  type SqlMigration,
} from "./runner";

type Cursor<T> = {
  toArray(): T[];
};

type MockSqlStorage = SqlStorage & {
  applied: AppliedSqlMigration[];
  statements: string[];
};

type MockDurableObjectStorage = {
  sql: MockSqlStorage;
  transactions: number;
  transactionSync<T>(closure: () => T): T;
};

function createMockSqlStorage(options: { failOn?: string } = {}): MockSqlStorage {
  const applied: AppliedSqlMigration[] = [];
  const statements: string[] = [];

  function cursor<T>(rows: T[] = []): Cursor<T> {
    return { toArray: () => rows };
  }

  function exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): Cursor<T> {
    const normalized = query.trim().replace(/\s+/g, " ");
    statements.push(normalized);

    if (options.failOn && normalized.includes(options.failOn)) {
      throw new Error("synthetic migration failure");
    }

    if (normalized.startsWith("SELECT component, id, name, checksum, applied_at FROM _gsv_schema_migrations")) {
      const [component] = bindings as [string];
      return cursor(applied.filter((migration) => migration.component === component) as T[]);
    }

    if (normalized.startsWith("INSERT INTO _gsv_schema_migrations")) {
      const [component, id, name, checksum, appliedAt] = bindings as [
        string,
        number,
        string,
        string,
        number,
      ];
      applied.push({
        component,
        id,
        name,
        checksum,
        applied_at: appliedAt,
      });
      return cursor<T>();
    }

    return cursor<T>();
  }

  return { exec, applied, statements } as MockSqlStorage;
}

function createMockDurableObjectStorage(options: { failOn?: string } = {}): MockDurableObjectStorage {
  const storage = {
    sql: createMockSqlStorage(options),
    transactions: 0,
    transactionSync<T>(closure: () => T): T {
      storage.transactions += 1;
      return closure();
    },
  };
  return storage;
}

const FIRST_MIGRATION: SqlMigration = {
  id: 1,
  name: "first",
  statements: ["CREATE TABLE first_table (id TEXT PRIMARY KEY)"],
};

describe("runSqlMigrations", () => {
  it("applies unapplied migrations and records them in the ledger", () => {
    const sql = createMockSqlStorage();

    runSqlMigrations(sql, "kernel", [FIRST_MIGRATION]);

    expect(sql.statements).toContain("CREATE TABLE first_table (id TEXT PRIMARY KEY)");
    expect(sql.applied).toHaveLength(1);
    expect(sql.applied[0]).toMatchObject({
      component: "kernel",
      id: 1,
      name: "first",
    });
    expect(sql.applied[0].checksum).toMatch(/^[0-9a-f]{8}$/);
  });

  it("uses Durable Object storage transactions when available", () => {
    const storage = createMockDurableObjectStorage();

    runSqlMigrations(storage, "kernel", [FIRST_MIGRATION]);

    expect(storage.transactions).toBe(1);
    expect(storage.sql.applied).toHaveLength(1);
  });

  it("skips migrations that are already recorded with the same checksum", () => {
    const sql = createMockSqlStorage();

    runSqlMigrations(sql, "kernel", [FIRST_MIGRATION]);
    runSqlMigrations(sql, "kernel", [FIRST_MIGRATION]);

    expect(sql.applied).toHaveLength(1);
    expect(sql.statements.filter((statement) => statement === "CREATE TABLE first_table (id TEXT PRIMARY KEY)")).toHaveLength(1);
  });

  it("rejects applied migrations whose content changed", () => {
    const sql = createMockSqlStorage();

    runSqlMigrations(sql, "kernel", [FIRST_MIGRATION]);

    expect(() => runSqlMigrations(sql, "kernel", [{
      ...FIRST_MIGRATION,
      statements: ["CREATE TABLE changed_table (id TEXT PRIMARY KEY)"],
    }])).toThrow("Schema migration kernel:1 has changed after being applied");
  });

  it("does not record the migration when a statement fails", () => {
    const sql = createMockSqlStorage({ failOn: "broken_table" });

    expect(() => runSqlMigrations(sql, "kernel", [{
      id: 1,
      name: "broken",
      statements: ["CREATE TABLE broken_table (id TEXT PRIMARY KEY)"],
    }])).toThrow("synthetic migration failure");

    expect(sql.applied).toHaveLength(0);
  });

  it("validates migration ordering before applying anything", () => {
    const sql = createMockSqlStorage();

    expect(() => runSqlMigrations(sql, "kernel", [
      { id: 2, name: "second", statements: [] },
      { id: 1, name: "first", statements: [] },
    ])).toThrow("Schema migrations must be sorted by ascending id: 1");
    expect(sql.statements).toHaveLength(0);
  });

  it("lists already applied migrations for a component", () => {
    const sql = createMockSqlStorage();

    runSqlMigrations(sql, "kernel", [FIRST_MIGRATION]);

    expect(listAppliedSqlMigrations(sql, "kernel")).toEqual(sql.applied);
  });
});
