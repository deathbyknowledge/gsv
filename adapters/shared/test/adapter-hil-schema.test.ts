import { describe, expect, it } from "vitest";

import {
  ADAPTER_HIL_MIGRATIONS,
  runAdapterHilSqlMigrations,
} from "../src/schema/migrations";
import { TestDurableObjectStorage } from "./sqlite-storage";

describe("adapter HIL schema migrations", () => {
  it("applies the versioned schema exactly once", () => {
    const storage = new TestDurableObjectStorage();
    const durableStorage = storage.asDurableStorage();

    runAdapterHilSqlMigrations(durableStorage);
    runAdapterHilSqlMigrations(durableStorage);

    expect(storage.rows<{ name: string }>(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table' AND name LIKE 'adapter_%'
       ORDER BY name`,
    ).map((row) => row.name)).toEqual(["adapter_hil_approvals"]);
    expect(storage.rows<{ id: number; name: string }>(
      `SELECT id, name
       FROM _gsv_schema_migrations
       WHERE component = 'adapter_hil'
       ORDER BY id`,
    )).toEqual(ADAPTER_HIL_MIGRATIONS.map(({ id, name }) => ({ id, name })));
  });
});
