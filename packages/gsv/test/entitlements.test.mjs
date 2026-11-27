import assert from "node:assert/strict";
import { test } from "node:test";
import { EntitlementCache } from "../dist/services/entitlements.js";
import { exceptionDiagnostics } from "../dist/telemetry.js";

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

test("rejects foreign and overlong snapshots", async () => {
  const now = Date.now();
  for (const value of [{ ...snapshot(now), installationId: "space-b" }, { ...snapshot(now), expiresAt: now + 300_001 }]) {
    await assert.rejects(new EntitlementCache({ getEntitlements: async () => value }, "space-a").get(now), /unavailable/);
  }
});

test("counts a snapshot's lifetime from the request, whatever the issuer's clock reads", async () => {
  const now = Date.now();
  for (const skew of [15, 10_000, -300_001]) {
    let calls = 0;
    const cache = new EntitlementCache({ getEntitlements: async () => { calls++; return snapshot(now + skew, { enabled: true }); } }, "space-a");
    assert.equal((await cache.get(now)).values.enabled, true);
    assert.equal((await cache.get(now + 299_999)).values.enabled, true);
    assert.equal(calls, 1);
    await cache.get(now + 300_000);
    assert.equal(calls, 2);
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

const refreshRecord = async (value, now) => {
  const records = [];
  const original = console.log;
  console.log = (record) => records.push(record);
  let error;
  try {
    error = await new EntitlementCache({ getEntitlements: async () => value }, "space-a",
      { env: { GSV_TELEMETRY_ENABLED: true }, component: "mail" }).get(now).then(() => assert.fail("admitted"), (cause) => cause);
  } finally { console.log = original; }
  assert.equal(records.length, 1);
  assert.equal(records[0].event.name, "entitlements.refresh.finished");
  assert.equal(records[0].event.properties.outcome, "invalid");
  assert.match(error.message, /^Space allowance is temporarily unavailable$/);
  return { properties: records[0].event.properties, error, serialized: JSON.stringify(records) };
};

test("records why an entitlement answer was rejected, without its values", async () => {
  const now = Date.now();
  const cases = [
    [{ ...snapshot(now), issuedAt: "private-issued" },
      { rejection: "schema", schemaPath: "issuedAt", schemaCode: "invalid_type" }],
    [snapshot(now, { "mail.enabled": { secret: "private-value" } }),
      { rejection: "schema", schemaPath: "values.mail.enabled", schemaCode: "invalid_union" }],
    [{ ...snapshot(now), "private-key": true },
      { rejection: "schema", schemaPath: "(root)", schemaCode: "unrecognized_keys" }],
    [{ ...snapshot(now), expiresAt: now + 300_001 },
      { rejection: "schema", schemaPath: "(root)", schemaCode: "custom" }],
    [{ ...snapshot(now), installationId: "private-space" }, { rejection: "installation-mismatch" }],
  ];
  for (const [value, reason] of cases) {
    const { properties, error, serialized } = await refreshRecord(value, now);
    const { outcome: _outcome, durationMs: _durationMs, ...recorded } = properties;
    assert.deepEqual(recorded, reason);
    assert.equal(serialized.includes("private"), false);
    for (const [key, field] of Object.entries(reason)) assert.ok(error.cause.message.includes(`${key}=${field}`), error.cause.message);
    assert.equal(error.cause.message.includes("private"), false);
    assert.ok(exceptionDiagnostics(error).exceptionCause.includes(`rejection=${reason.rejection}`));
  }
});

test("keeps an unavailable service's error as the cause of the allowance error", async () => {
  const upstream = new Error("upstream unavailable");
  const error = await new EntitlementCache({ getEntitlements: async () => { throw upstream; } }, "space-a").get()
    .then(() => assert.fail("admitted"), (cause) => cause);
  assert.match(error.message, /^Space allowance is temporarily unavailable$/);
  assert.equal(error.cause, upstream);
});
