import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import {
  createTelemetryRecord,
  emitTelemetry,
  integrationProviderFromName,
  integrationProviderFromUrl,
  integrationProviderSchema,
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

  it("accepts content-free failed provider attempts", () => {
    const failure = createTelemetryRecord({
      installationId: "inst_telemetry",
      component: "inference",
      event: {
        stream: "operational",
        name: "inference.provider_attempt.failed",
        properties: {
          purpose: "agent",
          workload: "interactive",
          provider: "workers-ai",
          model: "@cf/example/primary",
          attempt: 1,
          durationMs: 87,
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

  it("accepts bounded attempt timeout diagnostics and rejects invalid fields", () => {
    const timeout = createTelemetryRecord({
      installationId: "inst_telemetry",
      component: "inference",
      event: {
        stream: "operational",
        name: "inference.provider_attempt.failed",
        properties: {
          purpose: "agent",
          workload: "interactive",
          provider: "workers-ai",
          model: "@cf/example/primary",
          attempt: 1,
          durationMs: 90_000,
          failureKind: "timeout",
          failureStage: "provider",
          retryable: true,
          timeoutKind: "first_output",
          firstActivityMs: 50,
          lastActivityMs: 80,
          outputExposed: false,
        },
      },
    });
    assert.equal(telemetryRecordSchema.safeParse(timeout).success, true);
    for (const invalid of [
      { timeoutKind: "provider-specific detail" },
      { firstActivityMs: -1 },
      { lastActivityMs: "private data" },
      { outputExposed: "true" },
      { responseBody: "private response" },
    ]) {
      assert.equal(telemetryRecordSchema.safeParse({
        ...timeout,
        event: {
          ...timeout.event,
          properties: { ...timeout.event.properties, ...invalid },
        },
      }).success, false);
    }
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

describe("integration.connected", () => {
  it("accepts the closed kind and provider enums and rejects anything else", () => {
    const base = {
      installationId: "inst_telemetry",
      component: "gateway",
      event: {
        stream: "product",
        name: "integration.connected",
        properties: { integrationKind: "mcp", provider: "notion" },
      },
    };
    assert.equal(telemetryRecordSchema.safeParse(createTelemetryRecord(base)).success, true);
    for (const properties of [
      { integrationKind: "mcp-server", provider: "notion" },
      { integrationKind: "mcp", provider: "mcp.notion.com" },
      { integrationKind: "mcp", provider: "notion", url: "https://mcp.notion.com" },
      { integrationKind: "mcp" },
    ]) {
      assert.throws(() => createTelemetryRecord({
        ...base,
        event: { ...base.event, properties },
      }));
    }
  });

  it("classifies OAuth provider names into the allowlist", () => {
    assert.equal(integrationProviderFromName("openai-codex"), "openai-codex");
    assert.equal(integrationProviderFromName(" OpenAI_Codex "), "openai-codex");
    assert.equal(integrationProviderFromName("GitHub"), "github");
    assert.equal(integrationProviderFromName("acme-internal"), "other");
    assert.equal(integrationProviderFromName("other"), "other");
    assert.equal(integrationProviderFromName(""), "other");
  });

  it("classifies MCP server URLs by registrable domain only", () => {
    assert.equal(integrationProviderFromUrl("https://mcp.notion.com/mcp"), "notion");
    assert.equal(integrationProviderFromUrl("https://api.githubcopilot.com/mcp/"), "github");
    assert.equal(integrationProviderFromUrl("https://mcp.linear.app/sse"), "linear");
    assert.equal(integrationProviderFromUrl("https://team.atlassian.net/mcp"), "atlassian");
    assert.equal(integrationProviderFromUrl("https://notion.com.evil.example/mcp"), "other");
    assert.equal(integrationProviderFromUrl("https://mcp.example.com/mcp"), "other");
    assert.equal(integrationProviderFromUrl("http://localhost:3000/mcp"), "other");
    assert.equal(integrationProviderFromUrl("http://127.0.0.1/mcp"), "other");
    assert.equal(integrationProviderFromUrl("not a url"), "other");
  });

  it("only ever returns allowlist members", () => {
    for (const value of [
      integrationProviderFromName("https://mcp.notion.com/private/path"),
      integrationProviderFromUrl("https://user:secret@mcp.example.com/private/path"),
    ]) {
      assert.equal(integrationProviderSchema.safeParse(value).success, true);
      assert.equal(value, "other");
    }
  });
});
