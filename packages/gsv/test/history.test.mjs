import test from "node:test";
import assert from "node:assert/strict";
import {
  procHistoryEventKindSchema,
  procHistoryEventPayloadSchemas,
  procHistoryEventSchema,
  procHistoryRecordDataSchema,
  procHistoryRecordSchema,
  procHistoryArchivedRecordSchema,
  procHistoryTargetEventRegistry,
} from "../dist/protocol.js";

test("historical watched-signal records remain readable after source retirement", () => {
  const record = {
    kind: "event",
    payload: {
      kind: "signal.watched", severity: "info", audience: "model",
      payload: {
        signal: "proc.run.finished", sourcePid: "old-process",
        watch: { key: "completion", state: { count: 1 } },
        payload: { status: "ok", result: null },
      },
    },
  };
  assert.deepEqual(procHistoryRecordDataSchema.parse(record), record);
});

test("archive records preserve unknown source coordinates and timestamps", () => {
  const record = {
    kind: "note", payload: { text: "Old reasoning", thinking: [] },
    id: 2, messageId: 1, index: 1, generation: 3, runId: null, source: "legacy",
  };
  assert.deepEqual(procHistoryArchivedRecordSchema.parse(record), record);
  assert.equal(procHistoryRecordSchema.safeParse(record).success, false);
  const retained = { ...record, sourceMessageId: 50, createdAt: -0.5 };
  assert.deepEqual(procHistoryArchivedRecordSchema.parse(retained), retained);
  assert.equal(procHistoryArchivedRecordSchema.safeParse({ ...record, createdAt: null }).success, false);
  assert.equal(procHistoryArchivedRecordSchema.safeParse({ ...record, sourceMessageId: 0 }).success, false);
  const unlinkedResult = {
    ...record, kind: "result",
    payload: { callId: null, tool: "Read", outcome: "completed", output: "Old output", media: [], resources: [] },
  };
  assert.deepEqual(procHistoryArchivedRecordSchema.parse(unlinkedResult), unlinkedResult);
  assert.equal(procHistoryRecordSchema.safeParse({ ...unlinkedResult, createdAt: 1 }).success, false);
});

const resource = {
  type: "resource",
  ref: {
    type: "file",
    target: "gsv",
    path: "/home/ship/media/image.png",
    revision: "revision-1",
    contentType: "image/png",
    size: 42,
  },
  mediaType: "image",
};

test("typed history retains message origins and both durable and legacy media", () => {
  const message = {
    kind: "message",
    payload: {
      direction: "in",
      text: "An attachment",
      media: [resource, {
        type: "audio",
        mimeType: "audio/ogg",
        key: "media:legacy",
        conversationId: "conversation:ship",
        path: "/home/ship/media/old.ogg",
        description: "A voice message",
        revision: "immutable-revision",
        transcription: "An attachment",
      }],
      origin: {
        kind: "message",
        interaction: {
          kind: "adapter",
          adapter: "telegram",
          accountId: "account:1",
          actorId: "actor:1",
          surface: { kind: "thread", id: "chat:1", threadId: "thread:1" },
          actorLabel: "Person",
          messageId: "provider-message:1",
        },
        provenance: {
          source: "conversation",
          conversationId: "conversation:ship",
          messageId: "message:1",
        },
      },
      conversationId: "conversation:ship",
      conversationMessageId: "message:1",
      deliveryId: "delivery:1",
    },
  };
  assert.deepEqual(procHistoryRecordDataSchema.parse(message), message);
  const selected = { ...message, payload: { ...message.payload, selectedTarget: "macbook" } };
  assert.deepEqual(procHistoryRecordDataSchema.parse(selected), selected);
  assert.equal(procHistoryRecordDataSchema.safeParse({ ...message, payload: { ...message.payload, selectedTarget: 42 } }).success, false);
  assert.equal(procHistoryRecordDataSchema.safeParse({
    ...message,
    payload: {
      ...message.payload,
      media: [{ ...resource, ref: { ...resource.ref, revision: "" } }],
    },
  }).success, false);
});

test("notes and calls preserve provider signatures without adding note tags", () => {
  const note = {
    kind: "note",
    payload: {
      text: "I will inspect it.",
      thinking: [{
        type: "thinking",
        thinking: "",
        thinkingSignature: "opaque-thinking-signature",
        redacted: true,
      }],
      media: [resource],
    },
  };
  const call = {
    kind: "call",
    payload: {
      callId: "call:1",
      tool: "Read",
      syscall: "fs.read",
      args: { path: "/home/ship/test.txt", flags: [true, null, 1] },
      target: "gsv",
      runId: "run:1",
      thoughtSignature: "opaque-call-signature",
    },
  };
  assert.deepEqual(procHistoryRecordDataSchema.parse(note), note);
  assert.deepEqual(procHistoryRecordDataSchema.parse(call), call);
  assert.equal(procHistoryRecordDataSchema.safeParse({
    ...note,
    payload: { ...note.payload, tags: ["memory"] },
  }).success, false);
  assert.equal(procHistoryRecordDataSchema.safeParse({
    ...call,
    payload: { ...call.payload, args: "{}" },
  }).success, false);
});

test("history preserves finite legacy media numbers accepted by ingress", () => {
  for (const value of [-1.5, -0.25, 0, 42.5]) {
    const media = [{ type: "audio", mimeType: "audio/ogg", size: value, duration: value }];
    const records = [
      { kind: "message", payload: { direction: "in", text: "Audio", media, origin: {} } },
      { kind: "note", payload: { text: "Audio", thinking: [], media } },
      { kind: "result", payload: { callId: "call:1", tool: "Read", outcome: "completed", output: null, media, resources: [] } },
    ];
    for (const record of records) {
      assert.deepEqual(procHistoryRecordDataSchema.parse(JSON.parse(JSON.stringify(record))), record);
    }
  }
  for (const value of [NaN, Infinity, -Infinity, "-1", null]) {
    for (const field of ["size", "duration"]) {
      assert.equal(procHistoryRecordDataSchema.safeParse({
        kind: "message",
        payload: {
          direction: "in", text: "Audio", origin: {},
          media: [{ type: "audio", mimeType: "audio/ogg", [field]: value }],
        },
      }).success, false);
    }
  }
});

test("results retain structured run control output, resources, and typed failures", () => {
  const result = {
    kind: "result",
    payload: {
      callId: "call:send",
      tool: "Send",
      outcome: "completed",
      output: {
        action: "send",
        finish: true,
        delivery: { conversationId: "conversation:ship", messageId: "message:sent" },
      },
      media: [],
      resources: [resource],
    },
  };
  assert.deepEqual(procHistoryRecordDataSchema.parse(result), result);
  for (const outcome of ["failed", "denied", "cancelled"]) {
    const failure = {
      ...result,
      payload: {
        ...result.payload,
        outcome,
        output: { ok: false },
        error: { message: "Delivery unavailable", code: 503, details: { attempts: 2 } },
      },
    };
    assert.deepEqual(procHistoryRecordDataSchema.parse(failure), failure);
  }
  assert.equal(procHistoryRecordDataSchema.safeParse({
    ...result,
    payload: { ...result.payload, error: "untyped error" },
  }).success, false);
});

const projection = {
  version: 1,
  runtime: { date: "2026-09-08", timezone: "Europe/Amsterdam" },
  targets: [{ id: "gsv", implements: ["fs.read"], label: "Cloud" }],
  mcpServers: [],
  skills: { mode: "summary", entries: [{ id: "example", description: "An example skill" }] },
};
const policy = { overflow: "auto-compact", compactAtPressure: 0.8, compactToPressure: 0.5, updatedAt: 100 };
const source = { kind: "system", component: "kernel" };
const transition = {
  revision: 2,
  responsibilityId: "r12y:1",
  kind: "updated",
  beforeState: "open",
  afterState: "active",
  changedFields: ["state"],
  actor: source,
  record: {
    id: "r12y:1", ownerUid: 1, title: "Inspect an attachment", source,
    assignee: { kind: "ship" }, state: "active", priority: "normal",
    revision: 2, createdAtMs: 100, updatedAtMs: 200,
  },
  createdAtMs: 200,
};

const eventFixtures = {
  "context.changed": { epochId: "epoch:1", previous: projection, current: projection },
  "context.runway": { epochId: "epoch:1", remainingInputTokens: 100, runwayBeforeBoundaryTokens: 50, policy },
  "context.failed": { reason: "context.policy.fail", policy, pressure: 0.9 },
  "responsibility.revision": { epochId: "epoch:1", transition },
  "correction.text-only": { attempt: 1, limit: 3 },
  "correction.exhausted": { attempts: 3, limit: 3, conversationId: "conversation:1", messageId: "message:1" },
  "generation.failed": { reason: "generation.error", error: "Provider unavailable", provider: "provider", model: "model" },
  "delivery.failed": { phase: "run-finish", error: "Destination unavailable", attempts: 3, maxAttempts: 3 },
  "media.failed": { reason: "media.timeout", messageId: 1, error: "Media timed out" },
  "schedule.fired": { runId: "run:1", scheduleId: "schedule:1", message: "Inspect the attachment", firedAtMs: 100 },
  "signal.watched": { signal: "proc.changed", sourcePid: "proc:child", watch: { key: "watch:1", state: { active: true } }, payload: { status: "idle" } },
  "ipc.reply": { callId: "ipc:1", targetPid: "proc:child", response: { text: "Complete" } },
  "ipc.overdue": { callId: "ipc:1", nextCheckAt: 200, checkInCount: 1 },
  "ipc.timeout": { callId: "ipc:1", error: "Timed out" },
  "adapter.work.returned": { eventId: "event:1", workPid: "proc:child" },
  "history.compacted": { summary: "The earlier work is complete.", segmentId: "segment:1", archivedMessages: 10, archivePath: "/home/ship/archive.jsonl" },
  "runtime.wake": { source: "process", reason: "pending-events", pendingEvents: 1 },
  "runtime.failed": { reason: "schedule.error", error: "Could not load schedule" },
  "target.connection": { targetId: "machine:one", event: "connected", platform: "linux", observedAt: 100 },
};

test("responsibility events preserve context fields independently of the raw transition", () => {
  const event = {
    kind: "responsibility.revision",
    payload: {
      epochId: "epoch:1",
      transition: {
        ...transition,
        record: { ...transition.record, details: { task: "Inspect the attachment", options: ["image", "audio"] } },
      },
    },
    severity: "info",
    audience: "model",
  };
  for (const contextFields of [["title", "details", "state"], ["state"], []]) {
    const record = { kind: "event", payload: { ...event, payload: { ...event.payload, contextFields } } };
    assert.deepEqual(procHistoryRecordDataSchema.parse(record), record);
  }
  const olderEvent = procHistoryEventSchema.parse(event);
  assert.deepEqual(olderEvent, event);
  assert.equal(Object.hasOwn(olderEvent.payload, "contextFields"), false);
  for (const contextFields of [null, "state", ["state", 1]]) {
    assert.equal(procHistoryEventSchema.safeParse({ ...event, payload: { ...event.payload, contextFields } }).success, false);
  }
});

test("machine event registration has a typed payload and defaults to person-only delivery", () => {
  const definition = procHistoryTargetEventRegistry["target.status"];
  assert.equal(definition.kind, "target.connection");
  assert.equal(definition.defaultAudience, "person");
  assert.deepEqual(definition.allowedAudiences, ["person", "model", "both"]);
  assert.deepEqual(definition.payloadSchema.parse(eventFixtures[definition.kind]), eventFixtures[definition.kind]);
  assert.equal(definition.payloadSchema.safeParse({ ...eventFixtures[definition.kind], claimedOwnerUid: 0 }).success, false);
});

test("every registered event validates its own payload and rejects prose substitutes", () => {
  assert.deepEqual(Object.keys(eventFixtures).sort(), Object.keys(procHistoryEventPayloadSchemas).sort());
  for (const [kind, payload] of Object.entries(eventFixtures)) {
    const event = { kind, payload, severity: "info", audience: "model" };
    assert.deepEqual(procHistoryEventSchema.parse(event), event, kind);
    assert.equal(procHistoryEventSchema.safeParse({ ...event, payload: { text: "A runtime notice" } }).success, false, kind);
    assert.equal(procHistoryEventSchema.safeParse({ ...event, audience: "all" }).success, false, kind);
    assert.equal(procHistoryEventSchema.safeParse({ ...event, severity: "warning" }).success, false, kind);
    assert.equal(procHistoryEventSchema.safeParse({ kind, payload, severity: "info" }).success, false, kind);
  }
});

test("legacy events preserve exact prose and distinguish recognized events from new kinds", () => {
  const event = {
    kind: "legacy",
    payload: { text: "[GSV EVENT]\nAn older notice.\n", recognizedKind: "generation.failed" },
    severity: "error",
    audience: "both",
  };
  assert.deepEqual(procHistoryEventSchema.parse(event), event);
  assert.equal(procHistoryEventKindSchema.safeParse("legacy").success, false);
  assert.equal(procHistoryEventSchema.safeParse({ ...event, kind: "machine.custom" }).success, false);
  assert.equal(procHistoryEventSchema.safeParse({
    ...event, payload: { ...event.payload, recognizedKind: "machine.custom" },
  }).success, false);
});

test("record identity retains ordering within an original provider message", () => {
  const identity = {
    id: 2,
    messageId: 1,
    index: 1,
    generation: 0,
    runId: "run:1",
    createdAt: 100,
    source: "typed",
    metadata: {
      contextEpochId: "epoch:1",
      generationContextId: "generation:1",
      provider: { api: "provider-api", provider: "provider", model: "model", responseId: "response:1", stopReason: "toolUse" },
      fallback: { used: true, from: { provider: "first" }, to: { provider: "second" }, reason: "unavailable" },
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 3, totalTokens: 20, cost: null },
    },
  };
  const record = {
    ...identity,
    kind: "call",
    payload: { callId: "call:1", tool: "Send", syscall: null, args: { text: "Done" }, target: null, runId: "run:1" },
  };
  assert.deepEqual(procHistoryRecordSchema.parse(record), record);
  for (const field of ["id", "messageId", "index", "generation"]) {
    assert.equal(procHistoryRecordSchema.safeParse({ ...record, [field]: -1 }).success, false, field);
  }
  const preEpoch = { ...record, createdAt: -100.25 };
  assert.deepEqual(procHistoryRecordSchema.parse(preEpoch), preEpoch);
  for (const createdAt of [NaN, Infinity, -Infinity, "-1", null]) {
    assert.equal(procHistoryRecordSchema.safeParse({ ...record, createdAt }).success, false);
  }
  assert.equal(procHistoryRecordSchema.safeParse({ ...record, source: "inferred" }).success, false);
});
