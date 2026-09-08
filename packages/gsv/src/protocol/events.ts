import * as z from "zod/mini";
import { adapterSurfaceSchema } from "./adapters";
import { jsonObjectSchema, jsonValueSchema } from "./json";
import type { ProcHistoryContextPolicy } from "./syscalls/proc";
import type { ResponsibilityRecord, ResponsibilityTransition } from "./syscalls/responsibility";

const nonNegativeIntegerSchema = z.int().check(z.nonnegative());
const responsibilityStateSchema = z.enum(["open", "active", "waiting", "resolved", "cancelled"]);
const responsibilitySourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("account"), uid: z.number(), username: z.string() }),
  z.strictObject({ kind: z.literal("process"), processId: z.string(), runId: z.optional(z.string()) }),
  z.strictObject({ kind: z.literal("event"), eventType: z.string(), eventId: z.string() }),
  z.strictObject({ kind: z.literal("schedule"), scheduleId: z.string() }),
  z.strictObject({ kind: z.literal("system"), component: z.string() }),
]);
const responsibilityRecordSchema: z.ZodMiniType<ResponsibilityRecord> = z.strictObject({
  id: z.string(),
  ownerUid: z.number(),
  parentId: z.optional(z.string()),
  title: z.string(),
  details: z.optional(jsonObjectSchema),
  source: responsibilitySourceSchema,
  audience: z.optional(z.strictObject({ conversationIds: z.array(z.string()) })),
  assignee: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("ship") }),
    z.strictObject({ kind: z.literal("process"), processId: z.string() }),
  ]),
  state: responsibilityStateSchema,
  priority: z.enum(["low", "normal", "high", "critical"]),
  dueAtMs: z.optional(z.number()),
  nextCheckAtMs: z.optional(z.number()),
  blocker: z.optional(z.string()),
  leaseExpiresAtMs: z.optional(z.number()),
  dedupeKey: z.optional(z.string()),
  resolution: z.optional(jsonObjectSchema),
  revision: nonNegativeIntegerSchema,
  createdAtMs: z.number(),
  updatedAtMs: z.number(),
  resolvedAtMs: z.optional(z.number()),
});
const responsibilityTransitionSchema: z.ZodMiniType<ResponsibilityTransition> = z.strictObject({
  revision: nonNegativeIntegerSchema,
  responsibilityId: z.string(),
  kind: z.enum(["created", "updated", "resolved", "cancelled"]),
  beforeState: z.optional(responsibilityStateSchema),
  afterState: responsibilityStateSchema,
  changedFields: z.array(z.string()),
  actor: responsibilitySourceSchema,
  record: responsibilityRecordSchema,
  createdAtMs: z.number(),
});

const contextProjectionSchema = z.strictObject({
  version: z.literal(1),
  runtime: z.strictObject({ date: z.string(), timezone: z.string() }),
  targets: z.array(z.strictObject({
    id: z.string(),
    implements: z.array(z.string()),
    label: z.optional(z.string()),
    description: z.optional(z.string()),
    platform: z.optional(z.string()),
  })),
  mcpServers: z.array(z.string()),
  skills: z.strictObject({
    mode: z.enum(["summary", "names", "off"]),
    entries: z.array(z.strictObject({ id: z.string(), description: z.string() })),
  }),
});

const historyContextPolicySchema: z.ZodMiniType<ProcHistoryContextPolicy> = z.strictObject({
  overflow: z.enum(["auto-compact", "fail"]),
  compactAtPressure: z.number(),
  compactToPressure: z.number(),
  updatedAt: z.number(),
});

const ipcResponsePayloadSchema = z.strictObject({
  callId: z.optional(z.string()),
  targetPid: z.optional(z.string()),
  sourceRunId: z.optional(z.string()),
  createdAt: z.optional(z.number()),
  deadlineAt: z.optional(z.number()),
  nextCheckAt: z.optional(z.number()),
  checkInCount: z.optional(nonNegativeIntegerSchema),
  error: z.optional(z.string()),
  response: z.optional(jsonValueSchema),
});

export const procHistoryEventPayloadSchemas = {
  "context.changed": z.strictObject({
    epochId: z.string(),
    previous: contextProjectionSchema,
    current: contextProjectionSchema,
  }),
  "context.runway": z.strictObject({
    epochId: z.string(),
    remainingInputTokens: z.number(),
    runwayBeforeBoundaryTokens: z.number(),
    policy: historyContextPolicySchema,
  }),
  "context.failed": z.strictObject({
    reason: z.string(),
    trigger: z.optional(z.enum(["preflight", "provider-overflow"])),
    policy: z.optional(historyContextPolicySchema),
    pressure: z.optional(z.nullable(z.number())),
    beforePressure: z.optional(z.number()),
    afterPressure: z.optional(z.number()),
    error: z.optional(z.string()),
    provider: z.optional(z.string()),
    model: z.optional(z.string()),
  }),
  "responsibility.revision": z.strictObject({
    epochId: z.string(),
    transition: responsibilityTransitionSchema,
  }),
  "correction.text-only": z.strictObject({
    attempt: nonNegativeIntegerSchema,
    limit: nonNegativeIntegerSchema,
  }),
  "correction.exhausted": z.strictObject({
    attempts: nonNegativeIntegerSchema,
    limit: nonNegativeIntegerSchema,
    conversationId: z.optional(z.string()),
    messageId: z.optional(z.string()),
  }),
  "generation.failed": z.strictObject({
    reason: z.string(),
    error: z.string(),
    provider: z.optional(z.string()),
    model: z.optional(z.string()),
  }),
  "delivery.failed": z.strictObject({
    phase: z.enum(["message", "run-finish"]),
    noticeId: z.optional(z.string()),
    runId: z.optional(z.string()),
    error: z.string(),
    attempts: z.optional(nonNegativeIntegerSchema),
    maxAttempts: z.optional(nonNegativeIntegerSchema),
  }),
  "media.failed": z.strictObject({
    reason: z.enum(["media.error", "media.timeout"]),
    messageId: z.number(),
    error: z.string(),
  }),
  "schedule.fired": z.strictObject({
    runId: z.string(),
    scheduleId: z.string(),
    scheduleName: z.optional(z.string()),
    message: z.string(),
    data: z.optional(jsonObjectSchema),
    replyTo: z.optional(z.strictObject({
      kind: z.literal("adapter"),
      adapter: z.string(),
      accountId: z.string(),
      surface: adapterSurfaceSchema,
      actorId: z.string(),
    })),
    scheduledAtMs: z.optional(z.nullable(z.number())),
    firedAtMs: z.number(),
  }),
  "signal.watched": z.strictObject({
    signal: z.string(),
    sourcePid: z.optional(z.string()),
    watch: z.optional(z.strictObject({
      key: z.optional(z.string()),
      state: z.optional(jsonValueSchema),
    })),
    payload: z.optional(jsonValueSchema),
  }),
  "ipc.reply": ipcResponsePayloadSchema,
  "ipc.overdue": ipcResponsePayloadSchema,
  "ipc.timeout": ipcResponsePayloadSchema,
  "adapter.work.returned": z.strictObject({ eventId: z.string(), workPid: z.string() }),
  "history.compacted": z.strictObject({
    summary: z.string(),
    segmentId: z.string(),
    archivedMessages: nonNegativeIntegerSchema,
    archivePath: z.string(),
  }),
  "runtime.wake": z.strictObject({
    source: z.literal("process"),
    reason: z.optional(z.string()),
    pendingEvents: z.optional(nonNegativeIntegerSchema),
  }),
  "runtime.failed": z.strictObject({
    reason: z.literal("schedule.error"),
    error: z.string(),
    prefix: z.optional(z.string()),
  }),
};

export type ProcHistoryEventKind = keyof typeof procHistoryEventPayloadSchemas;
export type ProcHistoryEventPayload<K extends ProcHistoryEventKind> = z.infer<
  (typeof procHistoryEventPayloadSchemas)[K]
>;

export const procHistoryEventSeveritySchema = z.enum(["info", "warn", "error"]);
export const procHistoryEventAudienceSchema = z.enum(["model", "person", "both"]);
export type ProcHistoryEventSeverity = z.infer<typeof procHistoryEventSeveritySchema>;
export type ProcHistoryEventAudience = z.infer<typeof procHistoryEventAudienceSchema>;

function eventSchema<K extends ProcHistoryEventKind>(kind: K) {
  return z.strictObject({
    kind: z.literal(kind),
    payload: procHistoryEventPayloadSchemas[kind],
    severity: procHistoryEventSeveritySchema,
    audience: procHistoryEventAudienceSchema,
  });
}

// SAFETY: Object.keys returns exactly the keys of this nonempty, local registry.
const eventKinds = Object.keys(procHistoryEventPayloadSchemas) as [
  ProcHistoryEventKind, ...ProcHistoryEventKind[],
];
export const procHistoryEventKindSchema = z.enum(eventKinds);

export const procHistoryEventSchema = z.discriminatedUnion("kind", [
  eventSchema("context.changed"),
  eventSchema("context.runway"),
  eventSchema("context.failed"),
  eventSchema("responsibility.revision"),
  eventSchema("correction.text-only"),
  eventSchema("correction.exhausted"),
  eventSchema("generation.failed"),
  eventSchema("delivery.failed"),
  eventSchema("media.failed"),
  eventSchema("schedule.fired"),
  eventSchema("signal.watched"),
  eventSchema("ipc.reply"),
  eventSchema("ipc.overdue"),
  eventSchema("ipc.timeout"),
  eventSchema("adapter.work.returned"),
  eventSchema("history.compacted"),
  eventSchema("runtime.wake"),
  eventSchema("runtime.failed"),
  z.strictObject({
    kind: z.literal("legacy"),
    payload: z.strictObject({
      text: z.string(),
      recognizedKind: z.optional(procHistoryEventKindSchema),
    }),
    severity: procHistoryEventSeveritySchema,
    audience: procHistoryEventAudienceSchema,
  }),
]);

export type ProcHistoryEvent = z.infer<typeof procHistoryEventSchema>;
