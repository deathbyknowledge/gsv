import * as z from "zod/mini";
import { adapterSurfaceSchema } from "./adapters";
import { procHistoryEventSchema } from "./events";
import { jsonObjectSchema, jsonValueSchema } from "./json";
import { resourceBlockSchema } from "./resource";
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

export const procHistoryMediaSchema = z.union([resourceBlockSchema, historyLegacyMediaSchema]);
export type ProcHistoryMedia = z.infer<typeof procHistoryMediaSchema>;

export const procHistoryMessageOriginSchema = z.strictObject({
  interaction: z.optional(historyInteractionOriginSchema),
  kind: z.optional(z.string()),
  provenance: z.optional(jsonObjectSchema),
});
export type ProcHistoryMessageOrigin = z.infer<typeof procHistoryMessageOriginSchema>;

export const procHistoryMessagePayloadSchema = z.strictObject({
  direction: z.enum(["in", "out"]),
  text: z.string(),
  media: z.array(procHistoryMediaSchema),
  origin: procHistoryMessageOriginSchema,
  conversationId: z.optional(z.string()),
  conversationMessageId: z.optional(z.string()),
  deliveryId: z.optional(z.string()),
});
export type ProcHistoryMessagePayload = z.infer<typeof procHistoryMessagePayloadSchema>;

export const procHistoryThinkingSchema = z.strictObject({
  type: z.literal("thinking"),
  thinking: z.string(),
  thinkingSignature: z.optional(z.string()),
  redacted: z.optional(z.boolean()),
});
export type ProcHistoryThinking = z.infer<typeof procHistoryThinkingSchema>;

export const procHistoryNotePayloadSchema = z.strictObject({
  text: z.string(),
  thinking: z.array(procHistoryThinkingSchema),
  media: z.optional(z.array(procHistoryMediaSchema)),
});
export type ProcHistoryNotePayload = z.infer<typeof procHistoryNotePayloadSchema>;

export const procHistoryCallPayloadSchema = z.strictObject({
  callId: z.string(),
  tool: z.string(),
  syscall: z.nullable(z.string()),
  args: jsonObjectSchema,
  target: z.nullable(z.string()),
  runId: z.nullable(z.string()),
  thoughtSignature: z.optional(z.string()),
});
export type ProcHistoryCallPayload = z.infer<typeof procHistoryCallPayloadSchema>;

export const procHistoryResultErrorSchema = z.strictObject({
  message: z.string(),
  code: z.optional(z.union([z.number(), z.string()])),
  details: z.optional(jsonValueSchema),
});
export type ProcHistoryResultError = z.infer<typeof procHistoryResultErrorSchema>;

const resultOutcomeSchema: z.ZodMiniType<ProcToolResultOutcome> = z.enum([
  "completed", "failed", "denied", "cancelled",
]);

export const procHistoryResultPayloadSchema = z.strictObject({
  callId: z.string(),
  tool: z.string(),
  outcome: resultOutcomeSchema,
  output: jsonValueSchema,
  media: z.array(procHistoryMediaSchema),
  resources: z.array(resourceBlockSchema),
  error: z.optional(procHistoryResultErrorSchema),
});
export type ProcHistoryResultPayload = z.infer<typeof procHistoryResultPayloadSchema>;

export const procHistoryRecordDataSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("message"), payload: procHistoryMessagePayloadSchema }),
  z.strictObject({ kind: z.literal("note"), payload: procHistoryNotePayloadSchema }),
  z.strictObject({ kind: z.literal("call"), payload: procHistoryCallPayloadSchema }),
  z.strictObject({ kind: z.literal("result"), payload: procHistoryResultPayloadSchema }),
  z.strictObject({ kind: z.literal("event"), payload: procHistoryEventSchema }),
]);
export type ProcHistoryRecordData = z.infer<typeof procHistoryRecordDataSchema>;
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
