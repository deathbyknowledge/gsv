import { describe, expect, it } from "vitest";
import {
  captureSqlExportCatalog,
  readSqlExportPage,
} from "./sql-export";

describe("managed SQL export", () => {
  it("captures an immutable row boundary and emits portable binary values", () => {
    const sql = mockSqlStorage();
    const catalog = captureSqlExportCatalog(sql);

    expect(catalog).toEqual({
      format: "gsv-sql-snapshot",
      version: 1,
      tables: [{
        name: "records",
        createSql: "CREATE TABLE records (id INTEGER PRIMARY KEY, value BLOB)",
        restoreMode: "create",
        columns: ["id", "value"],
        rowCount: 2,
        throughRowId: 7,
      }],
      schemaObjects: [{
        type: "index",
        name: "records_value_idx",
        tableName: "records",
        createSql: "CREATE INDEX records_value_idx ON records(value)",
      }],
    });
    expect(readSqlExportPage(sql, catalog.tables[0]!, null)).toEqual({
      table: "records",
      columns: ["rowid", "id", "value"],
      rows: [
        [2, 2, { $bytes: "AQI" }],
        [7, 7, "final"],
      ],
      afterRowId: null,
      nextRowId: 7,
      throughRowId: 7,
      complete: true,
    });
  });

  it("rejects schema drift between catalog capture and page reads", () => {
    const sql = mockSqlStorage();
    const table = captureSqlExportCatalog(sql).tables[0]!;
    table.createSql = "CREATE TABLE records (changed TEXT)";

    expect(() => readSqlExportPage(sql, table, null)).toThrow(
      "changed during snapshot",
    );
  });
});

function mockSqlStorage(): SqlStorage {
  const schema = "CREATE TABLE records (id INTEGER PRIMARY KEY, value BLOB)";
  const cursor = <T>(rows: T[], rawRows: unknown[][] = []) => ({
    columnNames: ["__gsv_export_rowid__", "id", "value"],
    one: () => {
      if (rows.length !== 1) throw new Error("expected one row");
      return rows[0];
    },
    toArray: () => rows,
    raw: () => rawRows[Symbol.iterator](),
    rowsRead: rows.length,
    rowsWritten: 0,
    [Symbol.iterator]: () => rows[Symbol.iterator](),
  });
  return {
    exec(query: string, ...bindings: unknown[]) {
      const normalized = query.trim().replace(/\s+/g, " ");
      if (normalized.includes("FROM sqlite_schema") && normalized.includes("ORDER BY name")) {
        return cursor([{ name: "records", sql: schema }]);
      }
      if (normalized.includes("type IN ('index', 'trigger', 'view')")) {
        return cursor([{
          type: "index",
          name: "records_value_idx",
          table_name: "records",
          sql: "CREATE INDEX records_value_idx ON records(value)",
        }]);
      }
      if (normalized.startsWith("SELECT COUNT(*)")) {
        return cursor([{ row_count: 2, through_row_id: 7 }]);
      }
      if (normalized.startsWith("PRAGMA table_info")) {
        return cursor([{ name: "id" }, { name: "value" }]);
      }
      if (normalized.includes("FROM sqlite_schema") && bindings[0] === "records") {
        return cursor([{ name: "records", sql: schema }]);
      }
      if (normalized.startsWith("SELECT rowid AS __gsv_export_rowid__")) {
        return cursor([], [
          [2, 2, new Uint8Array([1, 2])],
          [7, 7, "final"],
        ]);
      }
      throw new Error(`unexpected SQL: ${normalized}`);
    },
    databaseSize: 0,
  } as unknown as SqlStorage;
}
