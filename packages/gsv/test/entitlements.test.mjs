import assert from "node:assert/strict";
import { test } from "node:test";
import { EntitlementCache } from "../dist/services/entitlements.js";

const snapshot = (now, values = {}) => ({ version: 1, installationId: "space-a", revision: "one",
  values, issuedAt: now, refreshAfter: now + 300_000, expiresAt: now + 300_000 });

test("coalesces refreshes, adopts changed policy at expiry, and never admits expired policy", async () => {
  const now = Date.now();
  let calls = 0;
  let current = snapshot(now, { enabled: true });
  let fail = false;
  const cache = new EntitlementCache({ getEntitlements: async () => {
    calls++;
    if (fail) throw new Error("private upstream error");
    return current;
  } }, "space-a");
  const results = await Promise.all([cache.get(now), cache.get(now)]);
  assert.equal(calls, 1);
  assert.deepEqual(results[0], results[1]);
  current = snapshot(now + 300_000, { enabled: false });
  assert.equal((await cache.get(now + 299_999)).values.enabled, true);
  assert.equal((await cache.get(now + 300_000)).values.enabled, false);
  assert.equal(calls, 2);
  fail = true;
  await assert.rejects(cache.get(now + 600_000), /temporarily unavailable/);
});

test("rejects foreign, expired, future and overlong snapshots", async () => {
  const now = Date.now();
  for (const value of [
    { ...snapshot(now), installationId: "space-b" }, snapshot(now - 300_001), snapshot(now + 10_000),
    { ...snapshot(now), expiresAt: now + 300_001 },
  ]) {
    await assert.rejects(new EntitlementCache({ getEntitlements: async () => value }, "space-a").get(now), /unavailable/);
  }
});

test("records refresh failures without exporting allowance values or exceptions", async () => {
  const records = [];
  const original = console.log;
  console.log = (record) => records.push(record);
  try {
    await assert.rejects(new EntitlementCache({ getEntitlements: async () => { throw new Error("private"); } },
      "space-a", { env: { GSV_TELEMETRY_ENABLED: true }, component: "mail" }).get());
  } finally { console.log = original; }
  assert.equal(records.length, 1);
  assert.equal(records[0].event.name, "entitlements.refresh.finished");
  assert.equal(records[0].event.properties.outcome, "unavailable");
  assert.equal(JSON.stringify(records).includes("private"), false);
});
