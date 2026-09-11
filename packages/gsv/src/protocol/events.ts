import * as z from "zod/mini";
import { adapterSurfaceSchema } from "./adapters";
import { jsonObjectSchema, jsonValueSchema, type JsonObject, type JsonValue } from "./json";
import type { ProcHistoryContextPolicy } from "./syscalls/proc";
import type { EventReplyTarget } from "./syscalls/interaction-origin";
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
    contextFields: z.optional(z.array(z.string())),
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
  // Read compatibility for staged history; child approvals no longer emit Process events.
  "process.approval": z.strictObject({
    pid: z.string(), runId: z.string(), requestId: z.string(),
    syscall: z.string(), target: z.string(),
    sourceRunId: z.string(), sourceCreatedAt: z.number(), observedAt: z.number(),
  }),
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
  "target.connection": z.strictObject({
    targetId: z.string(),
    event: z.enum(["connected", "disconnected"]),
    platform: z.string(),
    label: z.optional(z.string()),
    version: z.optional(z.string()),
    observedAt: z.number(),
  }),
} satisfies { [K in keyof ProcHistoryEventPayloadMap]: z.ZodMiniType<ProcHistoryEventPayloadMap[K]> };

export type ProcHistoryContextProjection = {
  version: 1;
  runtime: { date: string; timezone: string };
  targets: { id: string; implements: string[]; label?: string; description?: string; platform?: string }[];
  mcpServers: string[];
  skills: { mode: "summary" | "names" | "off"; entries: { id: string; description: string }[] };
};

export type ProcHistoryIpcResponsePayload = {
  callId?: string;
  targetPid?: string;
  sourceRunId?: string;
  createdAt?: number;
  deadlineAt?: number;
  nextCheckAt?: number;
  checkInCount?: number;
  error?: string;
  response?: JsonValue;
};

/** Structural wire types keep the generated protocol independent of schema implementation details. */
export type ProcHistoryEventPayloadMap = {
  "context.changed": { epochId: string; previous: ProcHistoryContextProjection; current: ProcHistoryContextProjection };
  "context.runway": {
    epochId: string;
    remainingInputTokens: number;
    runwayBeforeBoundaryTokens: number;
    policy: ProcHistoryContextPolicy;
  };
  "context.failed": {
    reason: string;
    trigger?: "preflight" | "provider-overflow";
    policy?: ProcHistoryContextPolicy;
    pressure?: number | null;
    beforePressure?: number;
    afterPressure?: number;
    error?: string;
    provider?: string;
    model?: string;
  };
  "responsibility.revision": {
    epochId: string;
    transition: ResponsibilityTransition;
    /** Exact record fields introduced or updated in model context; absent on older events. */
    contextFields?: string[];
  };
  "correction.text-only": { attempt: number; limit: number };
  "correction.exhausted": { attempts: number; limit: number; conversationId?: string; messageId?: string };
  "generation.failed": { reason: string; error: string; provider?: string; model?: string };
  "delivery.failed": {
    phase: "message" | "run-finish";
    noticeId?: string;
    runId?: string;
    error: string;
    attempts?: number;
    maxAttempts?: number;
  };
  "media.failed": { reason: "media.error" | "media.timeout"; messageId: number; error: string };
  "schedule.fired": {
    runId: string;
    scheduleId: string;
    scheduleName?: string;
    message: string;
    data?: JsonObject;
    replyTo?: EventReplyTarget;
    scheduledAtMs?: number | null;
    firedAtMs: number;
  };
  "signal.watched": { signal: string; sourcePid?: string; watch?: { key?: string; state?: JsonValue }; payload?: JsonValue };
  "ipc.reply": ProcHistoryIpcResponsePayload;
  "ipc.overdue": ProcHistoryIpcResponsePayload;
  "ipc.timeout": ProcHistoryIpcResponsePayload;
  "process.approval": {
    pid: string; runId: string; requestId: string;
    syscall: string; target: string; sourceRunId: string; sourceCreatedAt: number; observedAt: number;
  };
  "adapter.work.returned": { eventId: string; workPid: string };
  "history.compacted": { summary: string; segmentId: string; archivedMessages: number; archivePath: string };
  "runtime.wake": { source: "process"; reason?: string; pendingEvents?: number };
  "runtime.failed": { reason: "schedule.error"; error: string; prefix?: string };
  "target.connection": {
    targetId: string;
    event: "connected" | "disconnected";
    platform: string;
    label?: string;
    version?: string;
    observedAt: number;
  };
};

export type ProcHistoryEventKind = keyof ProcHistoryEventPayloadMap;
export type ProcHistoryEventPayload<K extends ProcHistoryEventKind> = ProcHistoryEventPayloadMap[K];

export const procHistoryEventSeveritySchema = z.enum(["info", "warn", "error"]);
export const procHistoryEventAudienceSchema = z.enum(["model", "person", "both"]);
export type ProcHistoryEventSeverity = "info" | "warn" | "error";
export type ProcHistoryEventAudience = "model" | "person" | "both";

/** Authorized target watches can produce only these registered, typed events. */
export const procHistoryTargetEventRegistry = {
  "target.status": {
    kind: "target.connection",
    payloadSchema: procHistoryEventPayloadSchemas["target.connection"],
    defaultAudience: "person",
    allowedAudiences: ["person", "model", "both"],
    severity: "info",
  },
} as const;

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

export const procHistoryEventSchema: z.ZodMiniType<ProcHistoryEvent> = z.discriminatedUnion("kind", [
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
  eventSchema("process.approval"),
  eventSchema("adapter.work.returned"),
  eventSchema("history.compacted"),
  eventSchema("runtime.wake"),
  eventSchema("runtime.failed"),
  eventSchema("target.connection"),
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

export type ProcHistoryEvent = ({
  [K in ProcHistoryEventKind]: { kind: K; payload: ProcHistoryEventPayload<K> }
}[ProcHistoryEventKind] | {
  kind: "legacy";
  payload: { text: string; recognizedKind?: ProcHistoryEventKind };
}) & {
  severity: ProcHistoryEventSeverity;
  audience: ProcHistoryEventAudience;
};
