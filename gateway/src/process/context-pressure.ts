import type { Context, Usage } from "@earendil-works/pi-ai";
import type { ProcContextPressureLevel, ProcContextState, ProcUsageState } from "@humansandmachines/gsv/protocol";

const TOKEN_ESTIMATE_CHARS_PER_TOKEN = 4;
const TOKEN_ESTIMATE_SAFETY_FACTOR = 1.15;
const IMAGE_DATA_ESTIMATE_PLACEHOLDER = "[image omitted from estimate]";
const WARN_PRESSURE = 0.75;
const CRITICAL_PRESSURE = 0.9;

export function estimateContextInputTokens(context: Context): number {
  const serialized = JSON.stringify(context, estimateContextReplacer);
  if (!serialized || serialized.length === 0) {
    return 0;
  }
  return Math.ceil(
    (serialized.length / TOKEN_ESTIMATE_CHARS_PER_TOKEN) * TOKEN_ESTIMATE_SAFETY_FACTOR,
  );
}

function estimateContextReplacer(_: string, value: unknown): unknown {
  if (isImageContent(value)) {
    return {
      type: "image",
      mimeType: value.mimeType,
      data: IMAGE_DATA_ESTIMATE_PLACEHOLDER,
    };
  }
  return value;
}

function isImageContent(value: unknown): value is { type: "image"; data: string; mimeType: string } {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return candidate.type === "image"
    && typeof candidate.data === "string"
    && typeof candidate.mimeType === "string";
}

export function buildProcContextState(input: {
  conversationId: string;
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
  conversationUsage?: ProcUsageState | null;
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

  return {
    conversationId: input.conversationId,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(typeof input.messageCount === "number" ? { messageCount: input.messageCount } : {}),
    ...(input.lastMessageId !== undefined ? { lastMessageId: input.lastMessageId } : {}),
    provider: input.provider,
    model: input.model,
    ...(input.reasoning?.trim() ? { reasoning: input.reasoning.trim() } : {}),
    contextWindowTokens,
    maxOutputTokens,
    estimatedInputTokens,
    inputTokens,
    ...(providerOutputTokens !== null ? { outputTokens: providerOutputTokens } : {}),
    ...(providerTotalTokens !== null ? { totalTokens: providerTotalTokens } : {}),
    ...(input.usageState ? { usage: input.usageState } : {}),
    ...(input.conversationUsage ? { conversationUsage: input.conversationUsage } : {}),
    availableInputTokens,
    pressure,
    level: levelForPressure(pressure),
    source: providerInputTokens !== null ? "provider" : "estimate",
    updatedAt: input.updatedAt ?? Date.now(),
  };
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

function normalizePositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : null;
}
