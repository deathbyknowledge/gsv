import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  createTelemetryRecord,
  ripgitFailureKindSchema,
  ripgitRouteSchema,
  telemetryRecordSchema,
} from "../dist/telemetry.js";

// ripgit's Rust unit tests check the same file, so the two vocabularies cannot drift apart.
const vocabulary = JSON.parse(readFileSync(new URL("./fixtures/ripgit-failure-vocabulary.json", import.meta.url), "utf8"));

const FAILURE = {
  installationId: "inst_ripgit",
  component: "ripgit",
  event: {
    stream: "operational", name: "ripgit.request.failed",
    properties: {
      diagnosticId: "11111111-1111-4111-8111-111111111111", outcome: "failed",
      route: "apply", kind: "repository", durationMs: 12,
    },
  },
};

describe("ripgit telemetry contract", () => {
  it("records an unexpected ripgit failure only from ripgit, without its cause", () => {
    assert.ok(telemetryRecordSchema.safeParse(createTelemetryRecord(FAILURE)).success);
    assert.throws(() => createTelemetryRecord({ ...FAILURE, component: "gateway" }));
    for (const extra of [
      { message: "Installation is retired" }, { route: "alice/home/apply" }, { kind: "SqliteError" }, { diagnosticId: "private" },
    ]) {
      assert.throws(() => createTelemetryRecord({
        ...FAILURE, event: { ...FAILURE.event, properties: { ...FAILURE.event.properties, ...extra } },
      }));
    }
  });

  it("names the failure kinds and routes ripgit reports", () => {
    assert.deepEqual(ripgitFailureKindSchema.options, vocabulary.kinds);
    assert.deepEqual(ripgitRouteSchema.options, vocabulary.routes);
  });
});
