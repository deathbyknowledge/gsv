import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { inferenceDiagnosticId, inferenceErrorMetadata, reportInferenceClientResult } from "../dist/services/inference-diagnostics.js";
import { telemetryRecordSchema } from "../dist/telemetry.js";

describe("inference diagnostics", () => {
  it("uses an independent correlation identity and replaces invalid input", () => {
    const id = inferenceDiagnosticId();
    assert.equal(inferenceDiagnosticId(id), id);
    assert.match(inferenceDiagnosticId("private-request-id"), /^[0-9a-f-]{36}$/);
    assert.notEqual(inferenceDiagnosticId(), id);
  });

  it("extracts closed exception metadata without exporting the exception", () => {
    const error = Object.assign(new TypeError("secret provider response"), {
      status: 503, remote: true, retryable: true, overloaded: false,
      cause: new Error("private path /home/someone"),
    });
    assert.deepEqual(inferenceErrorMetadata(error), {
      errorType: "TypeError", httpStatus: 503, rpcRemote: true, rpcRetryable: true, rpcOverloaded: false,
    });
    assert.deepEqual(inferenceErrorMetadata({ name: "private error category", status: 999 }), { errorType: "unknown" });
    assert.deepEqual(inferenceErrorMetadata("secret response"), { errorType: "unknown" });
  });

  it("validates correlation records and rejects extra error text", () => {
    const log = mock.method(console, "log", () => {});
    try {
      reportInferenceClientResult({ GSV_TELEMETRY_ENABLED: "1" }, {
        installationId: "inst_test", workload: "ipc",
      }, {
        diagnosticId: inferenceDiagnosticId(), boundary: "execution", phase: "acquisition",
        outcome: "failed", durationMs: 15, ...inferenceErrorMetadata(new Error("private")),
      });
      assert.equal(log.mock.callCount(), 1);
      const record = telemetryRecordSchema.parse(log.mock.calls[0].arguments[0]);
      assert.equal(record.component, "gateway");
      assert.equal(record.event.name, "inference.client.finished");
      assert.equal(record.event.properties.workload, "ipc");
      assert.equal(telemetryRecordSchema.safeParse({ ...record, event: {
        ...record.event, properties: { ...record.event.properties, error: "private" },
      } }).success, false);
    } finally {
      log.mock.restore();
    }
  });
});
