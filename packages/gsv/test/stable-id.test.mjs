import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { conversationSendMessageId } from "../dist/protocol/stable-id.js";

test("conversation send ids preserve the gateway's persisted identity derivation", async () => {
  const conversationId = "ship:1000";
  const key = "retry:with-unicode-☀";
  const legacyDigest = createHash("sha256").update(JSON.stringify([conversationId, key])).digest("hex");
  assert.equal(await conversationSendMessageId(conversationId, key), `msg:${legacyDigest}`);
  assert.notEqual(await conversationSendMessageId("ship:1001", key), `msg:${legacyDigest}`);
  assert.notEqual(await conversationSendMessageId(conversationId, "another-send"), `msg:${legacyDigest}`);
});
