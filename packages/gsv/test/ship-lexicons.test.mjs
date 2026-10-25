import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as protocol from "../dist/protocol.js";
import { SHIP_WIRE_FIXTURES } from "./ship-wire-fixtures.mjs";

test("Ships accept and refuse Ship-to-Ship values at the edges of each lexicon", async (context) => {
  for (const [schema, cases] of Object.entries(SHIP_WIRE_FIXTURES)) {
    await context.test(schema, () => {
      for (const { what, value, verdict } of cases) {
        assert.equal(protocol[schema].safeParse(value).success, verdict === "accept", what);
      }
    });
  }
});

test("a profile record keeps what this version knows and drops what a later version adds", () => {
  const record = { $type: "space.ship.profile", displayName: "Alice", contactPolicy: "requests" };
  assert.deepEqual(protocol.shipProfileRecordSchema.parse({ ...record, pronouns: "they/them" }), record);
});

test("the limits senders check are the lexicons'", () => {
  const deliver = lexicon("deliver").defs;
  assert.equal(protocol.MAX_FEDERATION_MESSAGE_BYTES, deliver.message.properties.text.maxLength);
  assert.equal(protocol.MAX_FEDERATION_MESSAGE_RESOURCES, deliver.message.properties.resources.maxLength);
  assert.equal(protocol.MAX_FEDERATION_RESOURCE_BYTES, deliver.resource.properties.size.maximum);
  assert.equal(protocol.MAX_FEDERATION_REQUEST_TITLE_BYTES, deliver.requestOffer.properties.title.maxLength);
  // Lexicon can't limit an object's encoded size, so a rule does.
  const details = (bytes) => ({ kind: "request.update", requestId: "request-1", expectedRevision: 1, state: "accepted", details: { text: "x".repeat(bytes - 11) } });
  assert.equal(protocol.federationDeliveryPayloadSchema.safeParse(details(protocol.MAX_FEDERATION_REQUEST_DETAILS_BYTES)).success, true);
  assert.equal(protocol.federationDeliveryPayloadSchema.safeParse(details(protocol.MAX_FEDERATION_REQUEST_DETAILS_BYTES + 1)).success, false);
  const avatar = lexicon("profile").defs.main.record.properties.avatar;
  assert.equal(protocol.PROFILE_AVATAR_MAX_BYTES, avatar.maxSize);
  assert.deepEqual(protocol.PROFILE_AVATAR_MIME_TYPES, avatar.accept);
});

function lexicon(name) {
  return JSON.parse(readFileSync(new URL(`../../../lexicons/space/ship/${name}.json`, import.meta.url), "utf8"));
}
