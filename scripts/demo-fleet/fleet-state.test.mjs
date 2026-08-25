import assert from "node:assert/strict";
import test from "node:test";
import {
  DEMO_INCIDENT_INDEXES,
  assessDevice,
  deviceIdForIndex,
  deviceIndexForId,
  repairedConfigFor,
  semanticEqual,
  validateGroundTruth,
} from "./fleet-state.mjs";

const restartAt = "2026-07-15T10:01:00Z";
const originalRestartAt = "2026-07-15T09:50:00Z";

function result(value) {
  return { ok: true, value, file: "/fixture" };
}

function expectedDevice(index, affected) {
  const deviceId = deviceIdForIndex(index);
  const originalNode = { deviceId, homeRegion: "us-east-1" };
  const originalConfig = {
    service: "checkout",
    paymentGatewayRegion: affected ? "eu-west-1" : "us-east-1",
    taxEngineV2: affected,
    nested: { preserved: true },
  };
  const originalHealth = {
    deviceId,
    service: "checkout",
    status: affected ? "degraded" : "ok",
    checkedAt: "2026-07-15T09:55:00Z",
    lastRestartAt: originalRestartAt,
    reason: affected ? "payment_timeout" : null,
    checks: {
      process: "running",
      configRegionMatchesHome: !affected,
      taxEngineV2Allowed: !affected,
      paymentGatewayReachable: !affected,
    },
  };
  const originalMetrics = {
    window: "5m",
    requests: 1_200 + index,
    checkoutErrors: affected ? 90 : 0,
    failureRate: affected ? 0.25 : 0.001,
    p95LatencyMs: affected ? 3_200 : 125,
    updatedAt: "2026-07-15T09:55:00Z",
  };
  return {
    index,
    affected,
    expectedHomeRegion: "us-east-1",
    originalNode,
    originalConfig,
    originalHealth,
    originalMetrics,
    originalServiceStatus: "running",
    originalLastRestartAt: originalRestartAt,
    expectedFixedConfig: { paymentGatewayRegion: "us-east-1", taxEngineV2: false },
    expectedRepairedConfig: {
      ...originalConfig,
      paymentGatewayRegion: "us-east-1",
      taxEngineV2: false,
    },
    expectedRepairedHealth: {
      deviceId,
      service: "checkout",
      status: "ok",
      checkedAt: "$RESTART_AT",
      lastRestartAt: "$RESTART_AT",
      reason: null,
      checks: {
        process: "running",
        configRegionMatchesHome: true,
        taxEngineV2Allowed: true,
        paymentGatewayReachable: true,
      },
    },
    expectedRepairedMetrics: {
      window: "5m",
      requests: originalMetrics.requests,
      checkoutErrors: 0,
      failureRate: 0.001,
      p95LatencyMs: 125,
      updatedAt: "$RESTART_AT",
    },
    expectedRepairedServiceStatus: "running",
    expectedRestart: {
      timestampToken: "$RESTART_AT",
      originalLastRestartAt: originalRestartAt,
      synchronizedFields: ["health.checkedAt", "health.lastRestartAt", "metrics.updatedAt"],
    },
  };
}

function recoveredFixture() {
  const deviceId = "edge-003";
  const expected = expectedDevice(3, true);
  const health = {
    ...expected.expectedRepairedHealth,
    checkedAt: restartAt,
    lastRestartAt: restartAt,
  };
  const metrics = { ...expected.expectedRepairedMetrics, updatedAt: restartAt };
  return {
    truth: {
      seededAt: "2026-07-15T10:00:00Z",
      repairTimestampToken: "$RESTART_AT",
    },
    device: {
      deviceId,
      expected,
      config: result(expected.expectedRepairedConfig),
      node: result(expected.originalNode),
      health: result(health),
      metrics: result(metrics),
      serviceStatus: result("running\n"),
      checkoutLog: result(
        `${restartAt} INFO service.restart requested service=checkout\n${restartAt} INFO checkout.recovered device=${deviceId} gateway_region=us-east-1\n`,
      ),
    },
  };
}

test("semantic equality ignores object key order but rejects extra state", () => {
  assert.equal(semanticEqual({ a: 1, nested: { b: 2 } }, { nested: { b: 2 }, a: 1 }), true);
  assert.equal(semanticEqual({ a: 1 }, { a: 1, extra: true }), false);
});

test("repaired config changes only the two approved fields", () => {
  const expected = expectedDevice(3, true);
  assert.deepEqual(repairedConfigFor(expected), expected.expectedRepairedConfig);
});

test("device IDs preserve three-digit defaults and canonically include edge-1000", () => {
  assert.equal(deviceIdForIndex(1), "edge-001");
  assert.equal(deviceIdForIndex(100), "edge-100");
  assert.equal(deviceIdForIndex(999), "edge-999");
  assert.equal(deviceIdForIndex(1_000), "edge-1000");
  assert.equal(deviceIndexForId("edge-001"), 1);
  assert.equal(deviceIndexForId("edge-1000"), 1_000);
  assert.equal(deviceIndexForId("edge-0001"), null);
  assert.equal(deviceIndexForId("edge-000"), null);
  assert.throws(() => deviceIdForIndex(1_001), /1 to 1000/);
});

test("partial deterministic fleets remain valid", () => {
  const devices = {};
  for (let index = 1; index <= 10; index += 1) {
    devices[deviceIdForIndex(index)] = expectedDevice(index, index === 3 || index === 8);
  }
  const truth = {
    scenario: "checkout-config-rollout-incident",
    generatedAt: "2026-07-15T10:00:00Z",
    repairTimestampToken: "$RESTART_AT",
    deviceCount: 10,
    affected: ["edge-003", "edge-008"],
    devices,
  };
  assert.deepEqual(validateGroundTruth(truth), []);
});

test("the strict deterministic schema accepts exactly 1,000 devices", () => {
  const incidentIndexes = new Set(DEMO_INCIDENT_INDEXES);
  const devices = {};
  for (let index = 1; index <= 1_000; index += 1) {
    devices[deviceIdForIndex(index)] = expectedDevice(index, incidentIndexes.has(index));
  }
  const truth = {
    schemaVersion: 2,
    scenario: "checkout-config-rollout-incident",
    seededAt: "2026-07-15T10:00:00Z",
    repairTimestampToken: "$RESTART_AT",
    deviceCount: 1_000,
    affected: DEMO_INCIDENT_INDEXES.map(deviceIdForIndex),
    devices,
  };

  assert.equal(Object.keys(devices).at(-1), "edge-1000");
  assert.deepEqual(validateGroundTruth(truth), []);
});

test("exact repaired state with synchronized post-seed evidence is recovered", () => {
  const fixture = recoveredFixture();
  const assessment = assessDevice(fixture.device, fixture.truth);
  assert.equal(assessment.recovered, true);
  assert.deepEqual(assessment.evidenceProblems, []);
  assert.deepEqual(assessment.repairedStateProblems, []);
});

test("stale health cannot claim recovery", () => {
  const fixture = recoveredFixture();
  fixture.device.health.value.checkedAt = originalRestartAt;
  fixture.device.health.value.lastRestartAt = originalRestartAt;
  const assessment = assessDevice(fixture.device, fixture.truth);
  assert.equal(assessment.recovered, false);
  assert.ok(assessment.evidenceProblems.length > 0);
});

test("an extra config change is drift, not repair", () => {
  const fixture = recoveredFixture();
  fixture.device.config.value = { ...fixture.device.config.value, unapproved: true };
  const assessment = assessDevice(fixture.device, fixture.truth);
  assert.equal(assessment.configRepaired, false);
  assert.equal(assessment.drift, true);
  assert.equal(assessment.recovered, false);
});
