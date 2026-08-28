import type {
  Context,
  Message,
  Usage,
} from "@earendil-works/pi-ai";
import type {
  ProcContextPressureLevel,
  ProcContextState,
  ProcContextUsageSource,
  ProcUsageState,
} from "@humansandmachines/gsv/protocol";
import { z } from "zod";
import {
  assistantContextEpochId,
  assistantGenerationContextId,
} from "./context-message-metadata";

const TOKEN_ESTIMATE_CHARS_PER_TOKEN = 4;
const TOKEN_ESTIMATE_SAFETY_FACTOR = 1.15;
const ESTIMATED_IMAGE_TOKENS = 1_200;
const ESTIMATED_IMAGE_DATA = "x".repeat(
  ESTIMATED_IMAGE_TOKENS * TOKEN_ESTIMATE_CHARS_PER_TOKEN,
);
const WARN_PRESSURE = 0.75;
const CRITICAL_PRESSURE = 0.9;

export type ContextInputMeasurement = {
  estimatedInputTokens: number;
  inputTokens: number;
  confirmedInputTokens: number;
  estimatedTrailingInputTokens: number;
  source: ProcContextUsageSource;
};

export function estimateContextInputTokens(context: Context): number {
  return measureContextInputTokens(context).estimatedInputTokens;
}

export function measureContextInputTokens(
  context: Context,
  target?: {
    provider: string;
    model: string;
    contextEpochId?: string;
    generationContextId?: string;
  },
  confirmedUsage?: Usage,
): ContextInputMeasurement {
  const estimatedInputTokens = applyEstimateSafety(estimateWholeContextTokens(context));
  const confirmedRequestTokens = confirmedUsage
    ? promptTokensFromUsage(confirmedUsage)
    : 0;
  if (confirmedRequestTokens > 0) {
    return {
      estimatedInputTokens,
      inputTokens: confirmedRequestTokens,
      confirmedInputTokens: confirmedRequestTokens,
      estimatedTrailingInputTokens: 0,
      source: "provider",
    };
  }

  const usageInfo = lastApplicableUsage(context.messages, target);
  if (!usageInfo) {
    return {
      estimatedInputTokens,
      inputTokens: estimatedInputTokens,
      confirmedInputTokens: 0,
      estimatedTrailingInputTokens: estimatedInputTokens,
      source: "estimate",
    };
  }

  let trailingTokens = estimateMessagesTokens(
    context.messages.slice(usageInfo.index + 1),
  );
  const addedToolNames = new Set(
    context.messages
      .slice(usageInfo.index + 1)
      .filter((message) => message.role === "toolResult")
      .flatMap((message) => message.addedToolNames ?? []),
  );
  if (addedToolNames.size > 0) {
    trailingTokens += estimateToolsTokens(
      context.tools?.filter((tool) => addedToolNames.has(tool.name)),
    );
  }
  const estimatedTrailingInputTokens = applyEstimateSafety(trailingTokens);
  return {
    estimatedInputTokens,
    inputTokens: usageInfo.tokens + estimatedTrailingInputTokens,
    confirmedInputTokens: usageInfo.tokens,
    estimatedTrailingInputTokens,
    source: estimatedTrailingInputTokens > 0 ? "mixed" : "provider",
  };
}

function lastApplicableUsage(
  messages: readonly Message[],
  target?: {
    provider: string;
    model: string;
    contextEpochId?: string;
    generationContextId?: string;
  },
): { index: number; tokens: number } | null {
  let latestPrefixTimestamp = Number.NEGATIVE_INFINITY;
  let result: { index: number; tokens: number } | null = null;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role === "assistant") {
      const tokens = contextTokensFromUsage(message.usage);
      const targetMatches = !target || (
        message.provider === target.provider
        && message.model === target.model
        && (
          target.contextEpochId === undefined
          || assistantContextEpochId(message) === target.contextEpochId
        )
        && (
          target.generationContextId === undefined
          || assistantGenerationContextId(message) === target.generationContextId
        )
      );
      if (
        targetMatches
        && message.timestamp >= latestPrefixTimestamp
        && message.stopReason !== "aborted"
        && message.stopReason !== "error"
        && tokens > 0
      ) {
        result = { index, tokens };
      }
    }
    if (message) {
      latestPrefixTimestamp = Math.max(latestPrefixTimestamp, message.timestamp);
    }
  }
  return result;
}

function contextTokensFromUsage(usage: Usage): number {
  const total = normalizeNonNegativeInt(usage.totalTokens);
  if (total !== null && total > 0) {
    return total;
  }
  return usageComponentsTotal(usage);
}

function promptTokensFromUsage(usage: Usage): number {
  const components = normalizeNonNegativeInt(usage.input) ?? 0;
  const cacheRead = normalizeNonNegativeInt(usage.cacheRead) ?? 0;
  const cacheWrite = normalizeNonNegativeInt(usage.cacheWrite) ?? 0;
  const promptTokens = components + cacheRead + cacheWrite;
  if (promptTokens > 0) {
    return promptTokens;
  }
  const total = normalizeNonNegativeInt(usage.totalTokens) ?? 0;
  const output = normalizeNonNegativeInt(usage.output) ?? 0;
  return Math.max(0, total - output);
}

function usageComponentsTotal(usage: Usage): number {
  return (normalizeNonNegativeInt(usage.input) ?? 0)
    + (normalizeNonNegativeInt(usage.output) ?? 0)
    + (normalizeNonNegativeInt(usage.cacheRead) ?? 0)
    + (normalizeNonNegativeInt(usage.cacheWrite) ?? 0);
}

function estimateWholeContextTokens(context: Context): number {
  return estimateSerializedTokens({
    ...context,
    messages: context.messages.map(messageForEstimate),
  });
}

function estimateMessagesTokens(messages: readonly Message[]): number {
  if (messages.length === 0) return 0;
  return estimateSerializedTokens(messages.map(messageForEstimate));
}

function estimateToolsTokens(tools: Context["tools"]): number {
  return tools && tools.length > 0
    ? estimateTextTokens(safeJsonStringify(tools))
    : 0;
}

function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / TOKEN_ESTIMATE_CHARS_PER_TOKEN);
}

function applyEstimateSafety(tokens: number): number {
  return Math.ceil(tokens * TOKEN_ESTIMATE_SAFETY_FACTOR);
}

function messageForEstimate(message: Message): Message {
  if (message.role === "assistant" || !Array.isArray(message.content)) {
    return message;
  }
  return {
    ...message,
    content: message.content.map((block) => (
      block.type === "image"
        ? { ...block, data: ESTIMATED_IMAGE_DATA }
        : block
    )),
  };
}

function safeJsonStringify<T>(value: T): string {
  try {
    return JSON.stringify(value) ?? "undefined";
  } catch {
    return "[unserializable]";
  }
}

function estimateSerializedTokens<T>(value: T): number {
  return estimateTextTokens(safeJsonStringify(value));
}

export function buildProcContextState(input: {
  revision: number;
  runId?: string;
  messageCount?: number;
  lastMessageId?: number | null;
  provider: string;
  model: string;
  reasoning?: string;
  contextWindowTokens?: number | null;
  maxOutputTokens: number;
  measurement: ContextInputMeasurement;
  usageState?: ProcUsageState | null;
  historyUsage?: ProcUsageState | null;
  updatedAt?: number;
}): ProcContextState {
  const contextWindowTokens = normalizePositiveInt(input.contextWindowTokens);
  const maxOutputTokens = Math.max(0, normalizePositiveInt(input.maxOutputTokens) ?? 0);
  const inputTokens = Math.max(0, normalizeNonNegativeInt(input.measurement.inputTokens) ?? 0);
  const inputBudgetTokens = contextWindowTokens === null
    ? null
    : Math.max(0, contextWindowTokens - maxOutputTokens);
  const remainingInputTokens = inputBudgetTokens === null
    ? null
    : Math.max(0, inputBudgetTokens - inputTokens);
  const pressure = inputBudgetTokens === null
    ? null
    : inputBudgetTokens === 0
      ? inputTokens > 0 ? 1 : 0
      : inputTokens / inputBudgetTokens;

  const state: ProcContextState = {
    revision: Math.max(0, normalizeNonNegativeInt(input.revision) ?? 0),
    provider: input.provider,
    model: input.model,
    contextWindowTokens,
    maxOutputTokens,
    estimatedInputTokens: input.measurement.estimatedInputTokens,
    inputTokens,
    confirmedInputTokens: input.measurement.confirmedInputTokens,
    estimatedTrailingInputTokens: input.measurement.estimatedTrailingInputTokens,
    inputBudgetTokens,
    remainingInputTokens,
    availableInputTokens: inputBudgetTokens,
    pressure,
    level: levelForPressure(pressure),
    source: input.measurement.source,
    updatedAt: input.updatedAt ?? Date.now(),
  };
  if (input.runId) state.runId = input.runId;
  if (input.messageCount !== undefined) state.messageCount = input.messageCount;
  if (input.lastMessageId !== undefined) state.lastMessageId = input.lastMessageId;
  if (input.reasoning?.trim()) state.reasoning = input.reasoning.trim();
  if (input.usageState) {
    state.outputTokens = input.usageState.outputTokens;
    state.totalTokens = input.usageState.totalTokens;
    state.usage = input.usageState;
  }
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

function normalizePositiveInt(value: number | null | undefined): number | null {
  const parsed = z.number().finite().safeParse(value);
  if (!parsed.success) return null;
  const normalized = Math.trunc(parsed.data);
  return normalized > 0 ? normalized : null;
}

function normalizeNonNegativeInt(value: number | null | undefined): number | null {
  const parsed = z.number().finite().safeParse(value);
  if (!parsed.success) return null;
  const normalized = Math.trunc(parsed.data);
  return normalized >= 0 ? normalized : null;
}
