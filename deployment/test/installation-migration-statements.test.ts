import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { splitInstallationMigrationSql } from "../src/installation-migration-statements.ts";

describe("SQLite migration statement boundaries", () => {
  it("executes consecutive triggers containing CASE END next to punctuation", () => {
    const source = `CREATE TABLE source (value INTEGER);
      CREATE TABLE audit (value TEXT);
      CREATE TRIGGER inserted AFTER INSERT ON source BEGIN
        INSERT INTO audit VALUES (CASE WHEN NEW.value = 1 THEN 'insert' ELSE 'other' END);
      END;
      CREATE TRIGGER updated AFTER UPDATE ON source BEGIN
        INSERT INTO audit VALUES (coalesce(CASE WHEN NEW.value = 2 THEN 'update' END,'other'));
      END;
      CREATE TRIGGER deleted AFTER DELETE ON source BEGIN
        INSERT INTO audit VALUES ('delete');
      END;
      INSERT INTO source VALUES (1); UPDATE source SET value = 2; DELETE FROM source;`;
    const statements = splitInstallationMigrationSql(source);
    expect(statements).toHaveLength(8);
    const database = new DatabaseSync(":memory:");
    try {
      for (const statement of statements) database.prepare(statement).run();
      expect(database.prepare("SELECT value FROM audit ORDER BY rowid").all().map((row) => row.value)).toEqual(["insert", "update", "delete"]);
    } finally { database.close(); }
  });

  it("keeps quoted and commented delimiters out of statement completion", () => {
    const source = `-- CREATE TRIGGER fake; END;
      CREATE TABLE [semi;colon] ("END;" TEXT);
      /* ; END; */ CREATE TEMPORARY TRIGGER \`quoted;trigger\` AFTER INSERT ON [semi;colon]
      BEGIN INSERT INTO [semi;colon] VALUES ('it''s ; END;'); END /* gap */;
      SELECT 'after;trigger', "END;" FROM [semi;colon] -- no final semicolon
    `;
    const statements = splitInstallationMigrationSql(source);
    expect(statements).toHaveLength(3);
    const database = new DatabaseSync(":memory:");
    try {
      for (const statement of statements) database.prepare(statement).run();
      expect(database.prepare("SELECT count(*) AS n FROM sqlite_temp_schema WHERE type = 'trigger'").get()?.n).toBe(1);
    } finally { database.close(); }
    expect(splitInstallationMigrationSql("; -- only comments\n /* ; END; */ ;")).toEqual([]);
  });

  it.each(["SELECT 'unfinished;", "SELECT [unfinished;", "/* unfinished", "CREATE TRIGGER a AFTER INSERT ON b BEGIN SELECT 1;"])("rejects incomplete source without splitting its contents: %s", (source) => {
    expect(() => splitInstallationMigrationSql(source)).toThrow(/unclosed|incomplete/);
  });
});
