/** Validation for Process records read from durable storage. */

import {
  type JsonValue, type ProcToolResultOutcome, type ProcTraceSpanReference,
} from "@humansandmachines/gsv/protocol";
import { z } from "zod";
import {
  archivedThinkingSchema as thinkingContentSchema,
  archivedToolCallSchema as toolCallSchema,
  optionalNonEmptyStringSchema,
} from "../internal/schemas";

export { toolCallSchema };

export const traceReferenceSchema: z.ZodType<ProcTraceSpanReference> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("run") }),
  z.object({ kind: z.literal("message"), messageId: z.number().int().positive() }),
  z.object({
    kind: z.literal("tool"),
    callId: z.string(),
    executionId: z.string(),
  }),
  z.object({
    kind: z.literal("approval"),
    requestId: z.string(),
    callId: z.string(),
  }),
  z.object({
    kind: z.literal("delivery"),
    callId: z.string().optional(),
    conversationId: z.string().optional(),
    messageId: z.string().optional(),
  }),
]);

export const toolCallStatusSchema = z.enum([
  "registered",
  "pending",
  "completed",
  "error",
]);

export const messageRoleSchema = z.enum(["user", "assistant", "system", "toolResult"]);

const optionalNonNegativeNumberSchema = z.number().finite().nonnegative().optional().catch(undefined);

const optionalPositiveIntegerSchema = z.number().finite().positive().transform(Math.trunc).optional().catch(undefined);

const usageCostSourceSchema = z.enum(["provider", "model-pricing", "mixed"]);

export const usageCostInputSchema = z.object({
  input: optionalNonNegativeNumberSchema,
  output: optionalNonNegativeNumberSchema,
  cacheRead: optionalNonNegativeNumberSchema,
  cacheWrite: optionalNonNegativeNumberSchema,
  total: optionalNonNegativeNumberSchema,
  source: usageCostSourceSchema.optional().catch(undefined),
});

export const usageStateInputSchema = z.object({
  inputTokens: optionalNonNegativeNumberSchema,
  input: optionalNonNegativeNumberSchema,
  outputTokens: optionalNonNegativeNumberSchema,
  output: optionalNonNegativeNumberSchema,
  cacheReadTokens: optionalNonNegativeNumberSchema,
  cacheRead: optionalNonNegativeNumberSchema,
  cacheWriteTokens: optionalNonNegativeNumberSchema,
  cacheWrite: optionalNonNegativeNumberSchema,
  totalTokens: optionalNonNegativeNumberSchema,
  generations: optionalPositiveIntegerSchema,
  costIncomplete: z.literal(true).optional().catch(undefined),
  updatedAt: optionalNonNegativeNumberSchema,
  cost: usageCostInputSchema.nullable().optional().catch(undefined),
});

const usageCostSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
  total: z.number().nonnegative(),
  currency: z.literal("USD"),
  source: usageCostSourceSchema,
});

const usageStateSchema = z.object({
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cacheReadTokens: z.number().nonnegative(),
  cacheWriteTokens: z.number().nonnegative(),
  totalTokens: z.number().nonnegative(),
  cost: usageCostSchema.nullable(),
  generations: z.number().int().nonnegative().optional(),
  costIncomplete: z.literal(true).optional(),
  updatedAt: z.number().nonnegative().optional(),
});

export const contextStateInputSchema = z.object({
  revision: z.number().finite().nonnegative().transform(Math.trunc).optional().catch(undefined),
  runId: z.string().optional(),
  messageCount: z.number().int().nonnegative().optional(),
  lastMessageId: z.number().int().nonnegative().nullable().optional(),
  provider: z.string(),
  model: z.string(),
  reasoning: z.string().optional(),
  contextWindowTokens: z.number().nonnegative().nullable(),
  maxOutputTokens: z.number().nonnegative(),
  estimatedInputTokens: z.number().nonnegative(),
  inputTokens: z.number().nonnegative(),
  confirmedInputTokens: optionalNonNegativeNumberSchema,
  estimatedTrailingInputTokens: optionalNonNegativeNumberSchema,
  outputTokens: z.number().nonnegative().optional(),
  totalTokens: z.number().nonnegative().optional(),
  usage: usageStateSchema.optional(),
  historyUsage: usageStateSchema.optional(),
  inputBudgetTokens: z.number().finite().nonnegative().nullable().optional().catch(undefined),
  remainingInputTokens: z.number().finite().nonnegative().nullable().optional().catch(undefined),
  availableInputTokens: z.number().finite().nonnegative().nullable(),
  pressure: z.number().nullable(),
  level: z.enum(["unknown", "ok", "warn", "critical", "full"]),
  source: z.enum(["estimate", "provider", "mixed"]),
  updatedAt: z.number().nonnegative(),
});

export const providerMetadataSchema = z.object({
  api: optionalNonEmptyStringSchema,
  provider: optionalNonEmptyStringSchema,
  model: optionalNonEmptyStringSchema,
  responseModel: optionalNonEmptyStringSchema,
  responseId: optionalNonEmptyStringSchema,
  stopReason: optionalNonEmptyStringSchema,
});

export const modelMetadataSchema = z.object({
  provider: optionalNonEmptyStringSchema,
  model: optionalNonEmptyStringSchema,
});

export const fallbackMetadataSchema = z.object({
  used: z.literal(true).optional().catch(undefined),
  from: z.unknown().optional(),
  to: z.unknown().optional(),
  reason: optionalNonEmptyStringSchema,
});

export const messageMetadataInputSchema = z.object({
  contextEpochId: optionalNonEmptyStringSchema,
  generationContextId: optionalNonEmptyStringSchema,
  provider: z.unknown().optional(),
  fallback: z.unknown().optional(),
  usage: z.unknown().optional(),
});

export const assistantMessageMetaSchema = z.object({
  thinking: z.array(thinkingContentSchema).optional(),
  toolCalls: z.array(toolCallSchema).optional(),
});

export const toolResultMetaSchema = z.object({
  toolName: z.string().optional(),
  isError: z.boolean().optional(),
  outcome: z.enum(["completed", "failed", "cancelled", "denied"]).optional(),
});

const failedToolResultSchema = z.object({ status: z.literal("failed") });

export function normalizeStoredToolResultOutcome(value: string | null): ProcToolResultOutcome | null {
  if (
    value === "completed"
    || value === "failed"
    || value === "cancelled"
    || value === "denied"
  ) {
    return value;
  }
  return null;
}

export function resolvedToolResultOutcome(result: JsonValue): "completed" | "failed" {
  return failedToolResultSchema.safeParse(result).success ? "failed" : "completed";
}
