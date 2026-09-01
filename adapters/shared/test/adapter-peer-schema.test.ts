import { describe, expect, it } from "vitest";

import {
  ADAPTER_PEER_MIGRATIONS,
  runAdapterPeerSqlMigrations,
} from "../src/schema/migrations";
import { TestDurableObjectStorage } from "./sqlite-storage";

describe("adapter peer schema migrations", () => {
  it("applies the versioned schema exactly once", () => {
    const storage = new TestDurableObjectStorage();
    const durableStorage = storage.asDurableStorage();

    runAdapterPeerSqlMigrations(durableStorage);
    runAdapterPeerSqlMigrations(durableStorage);

    expect(storage.rows<{ name: string }>(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table' AND name LIKE 'adapter_%'
       ORDER BY name`,
    ).map((row) => row.name)).toEqual([
      "adapter_hil_approvals",
      "adapter_peer_deliveries",
      "adapter_peer_delivery_chunks",
      "adapter_peer_delivery_stages",
    ]);
    expect(storage.rows<{ id: number; name: string }>(
      `SELECT id, name
       FROM _gsv_schema_migrations
       WHERE component = 'adapter_peer'
       ORDER BY id`,
    )).toEqual(ADAPTER_PEER_MIGRATIONS.map(({ id, name }) => ({ id, name })));
  });
});
