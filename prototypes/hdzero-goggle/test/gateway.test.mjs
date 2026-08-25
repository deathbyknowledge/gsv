import assert from "node:assert/strict";
import test from "node:test";

import { GsvBackend } from "../src/gateway.mjs";

const callbacks = {
  onSignal: () => {},
  onStatus: () => {},
  log: () => {},
};

test("client backend accepts password authentication", async () => {
  const backend = new GsvBackend({
    url: "wss://example.test/ws",
    username: "pilot",
    password: " secret ",
  }, callbacks);

  assert.equal(backend.config.password, "secret");
  assert.equal(backend.config.token, undefined);
  await backend.stop();
});

test("client backend requires exactly one credential", () => {
  assert.throws(() => new GsvBackend({
    url: "wss://example.test/ws",
    username: "pilot",
  }, callbacks), /GSV_PASSWORD or GSV_TOKEN/);

  assert.throws(() => new GsvBackend({
    url: "wss://example.test/ws",
    username: "pilot",
    password: "secret",
    token: "token",
  }, callbacks), /only one/);
});
