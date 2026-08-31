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
});
