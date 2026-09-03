import type { AssistantMessage } from "@earendil-works/pi-ai";
import { resourceBlockSchema } from "@humansandmachines/gsv/protocol";
import { z } from "zod";
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
  reason: string;
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
