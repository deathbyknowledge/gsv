import type { Context, Usage } from "@earendil-works/pi-ai";
import type { ProcContextPressureLevel, ProcContextState, ProcUsageState } from "@humansandmachines/gsv/protocol";
import { z } from "zod";

const TOKEN_ESTIMATE_CHARS_PER_TOKEN = 4;
const TOKEN_ESTIMATE_SAFETY_FACTOR = 1.15;
const IMAGE_DATA_ESTIMATE_PLACEHOLDER = "[image omitted from estimate]";
const WARN_PRESSURE = 0.75;
const CRITICAL_PRESSURE = 0.9;
const contextValueSchema = z.unknown();
type ContextWireValue = z.input<typeof contextValueSchema>;
const imageContentSchema = z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() });

export function estimateContextInputTokens(context: Context): number {
  const serialized = JSON.stringify(context, estimateContextReplacer);
  if (!serialized || serialized.length === 0) {
    return 0;
  }
  return Math.ceil(
    (serialized.length / TOKEN_ESTIMATE_CHARS_PER_TOKEN) * TOKEN_ESTIMATE_SAFETY_FACTOR,
  );
}

function estimateContextReplacer(_: string, value: ContextWireValue): ContextWireValue {
  if (isImageContent(value)) {
    return {
      type: "image",
      mimeType: value.mimeType,
      data: IMAGE_DATA_ESTIMATE_PLACEHOLDER,
    };
  }
  return value;
}

function isImageContent(value: ContextWireValue): value is z.infer<typeof imageContentSchema> {
  return imageContentSchema.safeParse(value).success;
}

export function buildProcContextState(input: {
  runId?: string;
  messageCount?: number;
  lastMessageId?: number | null;
  provider: string;
  model: string;
  reasoning?: string;
  contextWindowTokens?: number | null;
  maxOutputTokens: number;
  estimatedInputTokens: number;
  usage?: Usage;
  usageState?: ProcUsageState | null;
  historyUsage?: ProcUsageState | null;
  updatedAt?: number;
}): ProcContextState {
  const contextWindowTokens = normalizePositiveInt(input.contextWindowTokens);
  const maxOutputTokens = Math.max(0, normalizePositiveInt(input.maxOutputTokens) ?? 0);
  const estimatedInputTokens = Math.max(0, normalizePositiveInt(input.estimatedInputTokens) ?? 0);
  const providerInputTokens = normalizePositiveInt(input.usage?.input);
  const providerOutputTokens = normalizePositiveInt(input.usage?.output);
  const providerTotalTokens = normalizePositiveInt(input.usage?.totalTokens);
  const providerLiveInputTokens = providerTotalTokens
    ?? (providerInputTokens !== null && providerOutputTokens !== null
      ? providerInputTokens + providerOutputTokens
      : providerInputTokens);
  const inputTokens = providerLiveInputTokens ?? estimatedInputTokens;
  const availableInputTokens = contextWindowTokens === null
    ? null
    : Math.max(1, contextWindowTokens - maxOutputTokens);
  const pressure = availableInputTokens === null ? null : inputTokens / availableInputTokens;

  const state: ProcContextState = {
    provider: input.provider,
    model: input.model,
    contextWindowTokens,
    maxOutputTokens,
    estimatedInputTokens,
    inputTokens,
    availableInputTokens,
    pressure,
    level: levelForPressure(pressure),
    source: providerInputTokens !== null ? "provider" : "estimate",
    updatedAt: input.updatedAt ?? Date.now(),
  };
  if (input.runId) state.runId = input.runId;
  if (input.messageCount !== undefined) state.messageCount = input.messageCount;
  if (input.lastMessageId !== undefined) state.lastMessageId = input.lastMessageId;
  if (input.reasoning?.trim()) state.reasoning = input.reasoning.trim();
  if (providerOutputTokens !== null) state.outputTokens = providerOutputTokens;
  if (providerTotalTokens !== null) state.totalTokens = providerTotalTokens;
  if (input.usageState) state.usage = input.usageState;
  if (input.historyUsage) state.historyUsage = input.historyUsage;
  return state;
}

function levelForPressure(pressure: number | null): ProcContextPressureLevel {
  if (pressure === null || !Number.isFinite(pressure)) {
    return "unknown";
  }
  if (pressure >= 1) {
    return "full";
  }
  if (pressure >= CRITICAL_PRESSURE) {
    return "critical";
  }
  if (pressure >= WARN_PRESSURE) {
    return "warn";
  }
  return "ok";
}

function normalizePositiveInt(value: ContextWireValue): number | null {
  const parsed = z.number().finite().safeParse(value);
  if (!parsed.success) return null;
  const normalized = Math.trunc(parsed.data);
  return normalized > 0 ? normalized : null;
}
