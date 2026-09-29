import assert from "node:assert/strict";
import test from "node:test";
import { orderAiModelIds } from "../dist/protocol.js";

test("model order keeps live IDs, appends new models and supports a process preference", () => {
  const available = ["personal", "shared", "included", "new"];
  const saved = ["removed", "included", "shared", "included"];
  assert.deepEqual(orderAiModelIds(available, saved), ["included", "shared", "personal", "new"]);
  assert.deepEqual(orderAiModelIds(available, saved, " PERSONAL "), ["personal", "included", "shared", "new"]);
  assert.deepEqual(available, ["personal", "shared", "included", "new"]);
  assert.deepEqual(saved, ["removed", "included", "shared", "included"]);
});

test("no saved order retains configured fallback order and older first-choice semantics", () => {
  assert.deepEqual(orderAiModelIds(["one", "two", "three"]), ["one", "two", "three"]);
  assert.deepEqual(orderAiModelIds(["one", "two", "three"], undefined, "two"), ["two", "one", "three"]);
});
