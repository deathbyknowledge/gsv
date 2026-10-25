import assert from "node:assert/strict";
import { test } from "node:test";
import * as protocol from "../dist/protocol.js";
import { SHIP_WIRE_FIXTURES } from "./ship-wire-fixtures.mjs";

test("Ships accept and refuse Ship-to-Ship values at the edges of each lexicon", async (context) => {
  for (const [schema, cases] of Object.entries(SHIP_WIRE_FIXTURES)) {
    await context.test(schema, () => {
      for (const { what, value, base, verdict } of cases) {
        const parsed = protocol[schema].safeParse(value);
        assert.equal(parsed.success, verdict !== "refuse", what);
        if (verdict === "drop") assert.deepEqual(parsed.data, protocol[schema].parse(base), what);
      }
    });
  }
});

test("a profile record keeps what this version knows and drops what a later version adds", () => {
  const record = { $type: "space.ship.profile", displayName: "Alice", contactPolicy: "requests" };
  assert.deepEqual(protocol.shipProfileRecordSchema.parse({ ...record, pronouns: "they/them" }), record);
});
