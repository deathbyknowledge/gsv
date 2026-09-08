import * as z from "zod/mini";
import { adapterSurfaceSchema } from "./adapters";
import { procHistoryEventSchema, type ProcHistoryEvent } from "./events";
import { jsonObjectSchema, jsonValueSchema, type JsonObject, type JsonValue } from "./json";
import { resourceBlockSchema, type ResourceBlock } from "./resource";
import type { InteractionOrigin } from "./syscalls/interaction-origin";
import type { ProcMediaInput, ProcMessageMetadata, ProcToolResultOutcome } from "./syscalls/proc";

const nonNegativeIntegerSchema = z.int().check(z.nonnegative());
const positiveIntegerSchema = z.int().check(z.positive());
const nonNegativeNumberSchema = z.number().check(z.nonnegative());

const adapterMessageDestinationSchema = z.strictObject({
  kind: z.literal("adapter"),
  adapter: z.string(),
  accountId: z.string(),
  surface: adapterSurfaceSchema,
  actorId: z.string(),
});

const historyInteractionOriginSchema: z.ZodMiniType<InteractionOrigin> = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("client"),
    connectionId: z.string(),
    clientId: z.optional(z.string()),
    platform: z.optional(z.string()),
  }),
  z.strictObject({
    kind: z.literal("adapter"),
    adapter: z.string(),
    accountId: z.string(),
    surface: adapterSurfaceSchema,
    actorId: z.string(),
    actorLabel: z.optional(z.string()),
    messageId: z.optional(z.string()),
  }),
  z.strictObject({
    kind: z.literal("device"),
    deviceId: z.string(),
    cwd: z.optional(z.string()),
  }),
  z.strictObject({
    kind: z.literal("process"),
    sourcePid: z.string(),
    uid: z.optional(z.number()),
  }),
  z.strictObject({
    kind: z.literal("scheduler"),
    scheduleId: z.string(),
    replyTo: z.optional(adapterMessageDestinationSchema),
  }),
]);

const historyLegacyMediaSchema: z.ZodMiniType<ProcMediaInput & { description?: string; revision?: string }> = z.strictObject({
  type: z.enum(["image", "audio", "video", "document"]),
  mimeType: z.string(),
  key: z.optional(z.string()),
  conversationId: z.optional(z.string()),
  path: z.optional(z.string()),
  url: z.optional(z.string()),
  filename: z.optional(z.string()),
  // Match the finite numbers accepted by legacy ingress and stored descriptors.
  size: z.optional(z.number()),
  duration: z.optional(z.number()),
  transcription: z.optional(z.string()),
  description: z.optional(z.string()),
  revision: z.optional(z.string()),
});

export type ProcHistoryMedia = ResourceBlock | (ProcMediaInput & { description?: string; revision?: string });
export const procHistoryMediaSchema: z.ZodMiniType<ProcHistoryMedia> = z.union([resourceBlockSchema, historyLegacyMediaSchema]);

export const procHistoryMessageOriginSchema: z.ZodMiniType<ProcHistoryMessageOrigin> = z.strictObject({
  interaction: z.optional(historyInteractionOriginSchema),
  kind: z.optional(z.string()),
  provenance: z.optional(jsonObjectSchema),
});
export type ProcHistoryMessageOrigin = {
  interaction?: InteractionOrigin;
  kind?: string;
  provenance?: JsonObject;
};

export const procHistoryMessagePayloadSchema: z.ZodMiniType<ProcHistoryMessagePayload> = z.strictObject({
  direction: z.enum(["in", "out"]),
  text: z.string(),
  media: z.array(procHistoryMediaSchema),
  origin: procHistoryMessageOriginSchema,
  conversationId: z.optional(z.string()),
  conversationMessageId: z.optional(z.string()),
  deliveryId: z.optional(z.string()),
});
export type ProcHistoryMessagePayload = {
  direction: "in" | "out";
  text: string;
  media: ProcHistoryMedia[];
  origin: ProcHistoryMessageOrigin;
  conversationId?: string;
  conversationMessageId?: string;
  deliveryId?: string;
};

export const procHistoryThinkingSchema: z.ZodMiniType<ProcHistoryThinking> = z.strictObject({
  type: z.literal("thinking"),
  thinking: z.string(),
  thinkingSignature: z.optional(z.string()),
  redacted: z.optional(z.boolean()),
});
export type ProcHistoryThinking = {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
  redacted?: boolean;
};

export const procHistoryNotePayloadSchema: z.ZodMiniType<ProcHistoryNotePayload> = z.strictObject({
  text: z.string(),
  thinking: z.array(procHistoryThinkingSchema),
  media: z.optional(z.array(procHistoryMediaSchema)),
});
export type ProcHistoryNotePayload = {
  text: string;
  thinking: ProcHistoryThinking[];
  media?: ProcHistoryMedia[];
};

export const procHistoryCallPayloadSchema: z.ZodMiniType<ProcHistoryCallPayload> = z.strictObject({
  callId: z.string(),
  tool: z.string(),
  syscall: z.nullable(z.string()),
  args: jsonObjectSchema,
  target: z.nullable(z.string()),
  runId: z.nullable(z.string()),
  thoughtSignature: z.optional(z.string()),
});
export type ProcHistoryCallPayload = {
  callId: string;
  tool: string;
  syscall: string | null;
  args: JsonObject;
  target: string | null;
  runId: string | null;
  thoughtSignature?: string;
};

export const procHistoryResultErrorSchema: z.ZodMiniType<ProcHistoryResultError> = z.strictObject({
  message: z.string(),
  code: z.optional(z.union([z.number(), z.string()])),
  details: z.optional(jsonValueSchema),
});
export type ProcHistoryResultError = { message: string; code?: number | string; details?: JsonValue };

const resultOutcomeSchema: z.ZodMiniType<ProcToolResultOutcome> = z.enum([
  "completed", "failed", "denied", "cancelled",
]);

export const procHistoryResultPayloadSchema: z.ZodMiniType<ProcHistoryResultPayload> = z.strictObject({
  callId: z.string(),
  tool: z.string(),
  outcome: resultOutcomeSchema,
  output: jsonValueSchema,
  media: z.array(procHistoryMediaSchema),
  resources: z.array(resourceBlockSchema),
  error: z.optional(procHistoryResultErrorSchema),
});
export type ProcHistoryResultPayload = {
  callId: string;
  tool: string;
  outcome: ProcToolResultOutcome;
  output: JsonValue;
  media: ProcHistoryMedia[];
  resources: ResourceBlock[];
  error?: ProcHistoryResultError;
};

export const procHistoryRecordDataSchema: z.ZodMiniType<ProcHistoryRecordData> = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("message"), payload: procHistoryMessagePayloadSchema }),
  z.strictObject({ kind: z.literal("note"), payload: procHistoryNotePayloadSchema }),
  z.strictObject({ kind: z.literal("call"), payload: procHistoryCallPayloadSchema }),
  z.strictObject({ kind: z.literal("result"), payload: procHistoryResultPayloadSchema }),
  z.strictObject({ kind: z.literal("event"), payload: procHistoryEventSchema }),
]);
export type ProcHistoryRecordData =
  | { kind: "message"; payload: ProcHistoryMessagePayload }
  | { kind: "note"; payload: ProcHistoryNotePayload }
  | { kind: "call"; payload: ProcHistoryCallPayload }
  | { kind: "result"; payload: ProcHistoryResultPayload }
  | { kind: "event"; payload: ProcHistoryEvent };
export type ProcHistoryRecordKind = ProcHistoryRecordData["kind"];

const historyMessageModelMetadataSchema = z.strictObject({
  provider: z.optional(z.string()),
  model: z.optional(z.string()),
});

export const procHistoryMessageMetadataSchema: z.ZodMiniType<ProcMessageMetadata> = z.strictObject({
  contextEpochId: z.optional(z.string()),
  generationContextId: z.optional(z.string()),
  provider: z.optional(z.strictObject({
    api: z.optional(z.string()),
    provider: z.optional(z.string()),
    model: z.optional(z.string()),
    responseModel: z.optional(z.string()),
    responseId: z.optional(z.string()),
    stopReason: z.optional(z.string()),
  })),
  fallback: z.optional(z.strictObject({
    used: z.literal(true),
    from: z.optional(historyMessageModelMetadataSchema),
    to: z.optional(historyMessageModelMetadataSchema),
    reason: z.optional(z.string()),
  })),
  usage: z.optional(z.strictObject({
    inputTokens: nonNegativeNumberSchema,
    outputTokens: nonNegativeNumberSchema,
    cacheReadTokens: nonNegativeNumberSchema,
    cacheWriteTokens: nonNegativeNumberSchema,
    totalTokens: nonNegativeNumberSchema,
    cost: z.nullable(z.strictObject({
      input: nonNegativeNumberSchema,
      output: nonNegativeNumberSchema,
      cacheRead: nonNegativeNumberSchema,
      cacheWrite: nonNegativeNumberSchema,
      total: nonNegativeNumberSchema,
      currency: z.literal("USD"),
      source: z.enum(["provider", "model-pricing", "mixed"]),
    })),
    generations: z.optional(nonNegativeIntegerSchema),
    costIncomplete: z.optional(z.boolean()),
    updatedAt: z.optional(nonNegativeNumberSchema),
  })),
});

const historyRecordIdentityFields = {
  id: positiveIntegerSchema,
  messageId: positiveIntegerSchema,
  index: nonNegativeIntegerSchema,
  generation: nonNegativeIntegerSchema,
  runId: z.nullable(z.string()),
  // Archived history preserves finite timestamps, including dates before 1970.
  createdAt: z.number(),
  source: z.enum(["typed", "legacy"]),
  metadata: z.optional(procHistoryMessageMetadataSchema),
};

export type ProcHistoryRecord = ProcHistoryRecordData & {
  id: number;
  messageId: number;
  index: number;
  generation: number;
  runId: string | null;
  createdAt: number;
  /** Storage representation; promoted records may retain only inferred legacy data. */
  source: "typed" | "legacy";
  metadata?: ProcMessageMetadata;
};

export type ProcHistoryArchivedResultPayload = Omit<ProcHistoryResultPayload, "callId"> & {
  /** Older archives may not retain a result's tool-call linkage. */
  callId: string | null;
};

export type ProcHistoryArchivedRecordData =
  | Exclude<ProcHistoryRecordData, { kind: "result" }>
  | { kind: "result"; payload: ProcHistoryArchivedResultPayload };

/** Immutable archive coordinates are scoped by segment and remain stable across pages. */
export type ProcHistoryArchivedRecord = ProcHistoryArchivedRecordData & {
  /** One-based record ordinal across the full segment. */
  id: number;
  /** One-based logical message ordinal across the full segment. */
  messageId: number;
  index: number;
  /** Original stored parent id, when retained by the archive. */
  sourceMessageId?: number;
  generation: number;
  runId: string | null;
  createdAt?: number;
  source: "typed" | "legacy";
  metadata?: ProcMessageMetadata;
};

const historyArchivedRecordIdentityFields = {
  ...historyRecordIdentityFields,
  createdAt: z.optional(z.number()),
  sourceMessageId: z.optional(positiveIntegerSchema),
};

const historyArchivedResultPayloadSchema: z.ZodMiniType<ProcHistoryArchivedResultPayload> = z.strictObject({
  callId: z.nullable(z.string()),
  tool: z.string(),
  outcome: resultOutcomeSchema,
  output: jsonValueSchema,
  media: z.array(procHistoryMediaSchema),
  resources: z.array(resourceBlockSchema),
  error: z.optional(procHistoryResultErrorSchema),
});

export const procHistoryArchivedRecordSchema: z.ZodMiniType<ProcHistoryArchivedRecord> = z.discriminatedUnion("kind", [
  z.strictObject({ ...historyArchivedRecordIdentityFields, kind: z.literal("message"), payload: procHistoryMessagePayloadSchema }),
  z.strictObject({ ...historyArchivedRecordIdentityFields, kind: z.literal("note"), payload: procHistoryNotePayloadSchema }),
  z.strictObject({ ...historyArchivedRecordIdentityFields, kind: z.literal("call"), payload: procHistoryCallPayloadSchema }),
  z.strictObject({ ...historyArchivedRecordIdentityFields, kind: z.literal("result"), payload: historyArchivedResultPayloadSchema }),
  z.strictObject({ ...historyArchivedRecordIdentityFields, kind: z.literal("event"), payload: procHistoryEventSchema }),
]);

export const procHistoryRecordSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...historyRecordIdentityFields,
    kind: z.literal("message"),
    payload: procHistoryMessagePayloadSchema,
  }),
  z.strictObject({
    ...historyRecordIdentityFields,
    kind: z.literal("note"),
    payload: procHistoryNotePayloadSchema,
  }),
  z.strictObject({
    ...historyRecordIdentityFields,
    kind: z.literal("call"),
    payload: procHistoryCallPayloadSchema,
  }),
  z.strictObject({
    ...historyRecordIdentityFields,
    kind: z.literal("result"),
    payload: procHistoryResultPayloadSchema,
  }),
  z.strictObject({
    ...historyRecordIdentityFields,
    kind: z.literal("event"),
    payload: procHistoryEventSchema,
  }),
]);
