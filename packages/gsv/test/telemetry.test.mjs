import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import {
  createTelemetryRecord,
  emitTelemetry,
  telemetryRecordSchema,
} from "../dist/telemetry.js";

const INPUT = {
  installationId: "inst_telemetry",
  component: "gateway",
  event: {
    stream: "product",
    name: "target.connected",
    properties: { targetKind: "machine" },
  },
};

describe("telemetry contract", () => {
  it("creates a strict, versioned record", () => {
    const record = createTelemetryRecord(
      INPUT,
      1_789_000_000_000,
      "11111111-1111-4111-8111-111111111111",
    );

    assert.deepEqual(record, {
      marker: "gsv.telemetry",
      version: 1,
      eventId: "11111111-1111-4111-8111-111111111111",
      occurredAt: 1_789_000_000_000,
      ...INPUT,
    });
    assert.equal(telemetryRecordSchema.safeParse(record).success, true);
    assert.equal(telemetryRecordSchema.safeParse({
      ...record,
      event: {
        ...record.event,
        properties: { ...record.event.properties, path: "/private" },
      },
    }).success, false);
  });

  it("does nothing unless the deployment explicitly enables telemetry", () => {
    const log = mock.method(console, "log", () => {});
    try {
      assert.equal(emitTelemetry({}, INPUT), false);
      assert.equal(log.mock.callCount(), 0);
      assert.equal(emitTelemetry({ GSV_TELEMETRY_ENABLED: "1" }, INPUT), true);
      assert.equal(log.mock.callCount(), 1);
    } finally {
      log.mock.restore();
    }
  });

  it("accepts bounded inference failure diagnostics without raw errors", () => {
    const failure = createTelemetryRecord({
      installationId: "inst_telemetry",
      component: "inference",
      event: {
        stream: "operational",
        name: "inference.request.finished",
        properties: {
          outcome: "failed",
          purpose: "agent",
          workload: "ipc",
          provider: "workers-ai",
          model: "@cf/example/model",
          stopReason: "error",
          durationMs: 123,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
          costNanoUsd: 0,
          failureKind: "rate_limited",
          failureStage: "provider",
          retryable: true,
          providerStatusCode: 429,
        },
      },
    });

    assert.equal(telemetryRecordSchema.safeParse(failure).success, true);
    assert.equal(telemetryRecordSchema.safeParse({
      ...failure,
      event: {
        ...failure.event,
        properties: {
          ...failure.event.properties,
          errorMessage: "private provider response",
        },
      },
    }).success, false);
  });

  it("accepts terminal adapter route diagnostics without delivery content", () => {
    const failure = createTelemetryRecord({
      installationId: "inst_telemetry",
      component: "gateway",
      event: {
        stream: "operational",
        name: "adapter.route_delivery.failed",
        properties: {
          adapter: "telegram",
          deliveryKind: "message",
          surface: "dm",
          outcome: "failed",
          failureKind: "exhausted",
          attempts: 3,
        },
      },
    });

    assert.equal(telemetryRecordSchema.safeParse(failure).success, true);
    assert.equal(telemetryRecordSchema.safeParse({
      ...failure,
      event: {
        ...failure.event,
        properties: {
          ...failure.event.properties,
          errorMessage: "private adapter response",
        },
      },
    }).success, false);
  });
});
