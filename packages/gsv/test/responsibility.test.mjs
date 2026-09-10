import assert from "node:assert/strict";
import { test } from "node:test";
import { responsibilityRequiresAction } from "../dist/protocol.js";

const waiting = { assignee: { kind: "ship" }, state: "waiting", blocker: "Waiting for an answer" };

test("a due Ship check needs review even when its blocker is unchanged", () => {
  assert.equal(responsibilityRequiresAction({ ...waiting, nextCheckAtMs: 2_000 }, 1_999), false);
  assert.equal(responsibilityRequiresAction({ ...waiting, nextCheckAtMs: 2_000 }, 2_000), true);
  assert.equal(responsibilityRequiresAction({ ...waiting, nextCheckAtMs: 2_000 }, 2_001), true);
});

test("resolution and explicit deferral finish the review without requiring a message", () => {
  for (const state of ["resolved", "cancelled"]) {
    assert.equal(responsibilityRequiresAction({ ...waiting, state, nextCheckAtMs: 2_000 }, 3_000), false);
  }
  assert.equal(responsibilityRequiresAction(waiting, 3_000), false);
  assert.equal(responsibilityRequiresAction({ ...waiting, nextCheckAtMs: 4_000 }, 3_000), false);
});

test("delegated assignments retain their own supervision conditions", () => {
  const delegated = { ...waiting, assignee: { kind: "process", processId: "worker" }, nextCheckAtMs: 2_000 };
  assert.equal(responsibilityRequiresAction({ ...delegated, state: "active", leaseExpiresAtMs: 4_000 }, 3_000), false);
  assert.equal(responsibilityRequiresAction({ ...delegated, leaseExpiresAtMs: 2_000 }, 3_000), true);
});
