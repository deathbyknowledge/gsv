import type { Context, Usage } from "@mariozechner/pi-ai";
import type { ProcContextPressureLevel, ProcContextState } from "../syscalls/proc";

const TOKEN_ESTIMATE_CHARS_PER_TOKEN = 4;
const TOKEN_ESTIMATE_SAFETY_FACTOR = 1.15;
const WARN_PRESSURE = 0.75;
const CRITICAL_PRESSURE = 0.9;

export function estimateContextInputTokens(context: Context): number {
  const serialized = JSON.stringify(context);
  if (!serialized || serialized.length === 0) {
    return 0;
  }
  return Math.ceil(
    (serialized.length / TOKEN_ESTIMATE_CHARS_PER_TOKEN) * TOKEN_ESTIMATE_SAFETY_FACTOR,
  );
}

export function buildProcContextState(input: {
  conversationId: string;
  runId?: string;
  messageCount?: number;
  lastMessageId?: number | null;
  provider: string;
  model: string;
  contextWindowTokens?: number | null;
  maxOutputTokens: number;
  estimatedInputTokens: number;
  usage?: Usage;
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
    contextWindowTokens,
    maxOutputTokens,
    estimatedInputTokens,
    inputTokens,
    ...(providerOutputTokens !== null ? { outputTokens: providerOutputTokens } : {}),
    ...(providerTotalTokens !== null ? { totalTokens: providerTotalTokens } : {}),
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
