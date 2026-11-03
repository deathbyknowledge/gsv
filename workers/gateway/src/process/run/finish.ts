import type { AssistantMessage } from "@humansandmachines/gsv/services/inference-context";
import { resourceBlockSchema } from "@humansandmachines/gsv/protocol";
import { z } from "zod";
import type { ConversationReplyFailure } from "@humansandmachines/gsv/telemetry";
import { runOutputMediaSchema } from "./state";

const assistantUsageSchema: z.ZodType<AssistantMessage["usage"]> = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  cacheWrite1h: z.number().optional(),
  reasoning: z.number().optional(),
  totalTokens: z.number(),
  cost: z.object({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
    total: z.number(),
  }),
});
const runFinishStatusSchema = z.enum(["ok", "error", "aborted"]);
const runResultSchema = z.object({
  text: z.string().nullable(),
  media: z.array(z.union([resourceBlockSchema, runOutputMediaSchema])).optional(),
});
const runDeliverySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({
    kind: z.literal("message"),
    conversationId: z.string().optional(),
    messageId: z.string().optional(),
  }),
  z.object({ kind: z.literal("silence"), reason: z.string().optional() }),
]);
const pendingRunFinishFields = {
  pid: z.string(),
  runId: z.string(),
  status: runFinishStatusSchema,
  reason: z.string().optional(),
  error: z.string().optional(),
  usage: assistantUsageSchema.optional(),
  aborted: z.literal(true).optional(),
  queuedCount: z.number().int().nonnegative(),
  timestamp: z.number(),
  deliveryAttempts: z.number().int().nonnegative().optional(),
};
const pendingRunFinishSchema = z.object({
  ...pendingRunFinishFields,
  result: runResultSchema,
  delivery: runDeliverySchema,
});

export type RunResult = z.infer<typeof runResultSchema>;
export type RunDelivery = z.infer<typeof runDeliverySchema>;
type RunFinishStatus = z.infer<typeof runFinishStatusSchema>;
export type RunFinishPayload = z.infer<typeof pendingRunFinishSchema>;

export type RunFinishOptions = {
  reason: RunFinishReason;
  status?: RunFinishStatus;
  resultText?: string | null;
  delivery?: RunDelivery;
  error?: string | null;
  usage?: AssistantMessage["usage"];
};
const legacyPendingRunFinishSchema = z.object({
  ...pendingRunFinishFields,
  text: z.string().nullable(),
  media: z.array(z.union([resourceBlockSchema, runOutputMediaSchema])).optional(),
});

export const pendingRunFinishesSchema = z.array(z.union([
  pendingRunFinishSchema,
  legacyPendingRunFinishSchema,
])).transform((finishes): RunFinishPayload[] => finishes.map((finish) => {
  if ("result" in finish) return finish;
  const delivery: RunDelivery = finish.reason === "message.sent"
    ? { kind: "message" }
    : finish.reason === "message.silenced"
      ? { kind: "silence" }
      : { kind: "none" };
  const result: RunResult = { text: finish.text };
  if (finish.media) result.media = finish.media;
  const normalized: RunFinishPayload = {
    pid: finish.pid,
    runId: finish.runId,
    status: finish.status,
    result,
    delivery,
    queuedCount: finish.queuedCount,
    timestamp: finish.timestamp,
  };
  if (finish.reason) normalized.reason = finish.reason;
  if (finish.error) normalized.error = finish.error;
  if (finish.usage) normalized.usage = finish.usage;
  if (finish.aborted) normalized.aborted = true;
  if (finish.deliveryAttempts !== undefined) {
    normalized.deliveryAttempts = finish.deliveryAttempts;
  }
  return normalized;
}));

/**
 * Every reason a run finishes with, and the closed category it reports when a
 * person's message started the run and it ended in `error` or `aborted`.
 * Reasons that only end a run normally report nothing and map to null. A new
 * reason must be added here, with its category, before any producer can use it.
 */
const RUN_FINISH_REPLY_FAILURES = {
  "run.yielded": null,
  "ipc.returned": null,
  "generation.error": "generation",
  "generation.empty": "generation",
  "context.provider_overflow": "context",
  "context.checkpoint.failed": "context",
  "context.policy.fail": "context",
  "context.auto_compact.empty": "context",
  "context.auto_compact.failed": "context",
  "context.auto_compact.insufficient": "context",
  "media.error": "media",
  "media.timeout": "media",
  "message.action.missing": "no_send",
  "message.command.failed": "command",
  "message.delivery.failed": "delivery",
  "schedule.error": "runtime",
  "tick.error": "runtime",
  "recovery.schedule.error": "runtime",
  "user.superseded": "superseded",
  "user": "cancelled",
  "process.reset": "cancelled",
  "process.kill": "killed",
} as const satisfies Record<string, ConversationReplyFailure | null>;

export type RunFinishReason = keyof typeof RUN_FINISH_REPLY_FAILURES;

/**
 * Classify how a run that a person's message started ended, as a closed
 * category. The finish reason and error text stay in Process history.
 */
export function replyFailureFromFinish(reason: RunFinishReason): ConversationReplyFailure {
  // A completion reason never ends a failed run; keep the record valid if one ever does.
  return RUN_FINISH_REPLY_FAILURES[reason] ?? "other";
}
