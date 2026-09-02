/** Provider, context, and usage metadata normalization. */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  JsonValue, ProcContextState, ProcMessageModelMetadata, ProcUsageCost, ProcUsageState,
} from "@humansandmachines/gsv/protocol";
import { z } from "zod";
import {
  contextStateInputSchema, fallbackMetadataSchema, messageMetadataInputSchema, modelMetadataSchema,
  providerMetadataSchema, usageCostInputSchema, usageStateInputSchema,
} from "./validation";
import type { MessageMetadata, MessageProviderMetadata } from "./records";

export function parseMessageMetadata(raw: string | null | undefined): MessageMetadata | null {
  if (!raw) {
    return null;
  }
  try {
    return normalizeMessageMetadata(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function stringifyMessageMetadata(
  metadata: MessageMetadata | string | null | undefined,
): string | null {
  if (metadata === undefined || metadata === null) {
    return null;
  }
  const serialized = z.string().safeParse(metadata);
  if (serialized.success) {
    const normalized = parseMessageMetadata(serialized.data);
    return normalized ? JSON.stringify(normalized) : null;
  }
  const objectMetadata = messageMetadataInputSchema.safeParse(metadata);
  if (!objectMetadata.success) {
    return null;
  }
  const normalized = normalizeMessageMetadata(objectMetadata.data);
  return normalized ? JSON.stringify(normalized) : null;
}

export function normalizeMessageMetadata(
  value: Parameters<typeof messageMetadataInputSchema.safeParse>[0],
): MessageMetadata | null {
  const parsed = messageMetadataInputSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  const provider = normalizeProviderMetadata(parsed.data.provider);
  const fallback = normalizeFallbackMetadata(parsed.data.fallback);
  const usage = normalizeUsageState(parsed.data.usage);
  const contextEpochId = parsed.data.contextEpochId?.trim() || undefined;
  const generationContextId = parsed.data.generationContextId?.trim() || undefined;
  if (!contextEpochId && !generationContextId && !provider && !fallback && !usage) {
    return null;
  }
  const metadata: MessageMetadata = {};
  if (contextEpochId) metadata.contextEpochId = contextEpochId;
  if (generationContextId) metadata.generationContextId = generationContextId;
  if (provider) metadata.provider = provider;
  if (fallback) metadata.fallback = fallback;
  if (usage) metadata.usage = usage;
  return metadata;
}

function normalizeProviderMetadata(
  value: Parameters<typeof providerMetadataSchema.safeParse>[0],
): MessageProviderMetadata | null {
  const parsed = providerMetadataSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  const provider: MessageProviderMetadata = {};
  if (parsed.data.api) provider.api = parsed.data.api;
  if (parsed.data.provider) provider.provider = parsed.data.provider;
  if (parsed.data.model) provider.model = parsed.data.model;
  if (parsed.data.responseModel) provider.responseModel = parsed.data.responseModel;
  if (parsed.data.responseId) provider.responseId = parsed.data.responseId;
  if (parsed.data.stopReason) provider.stopReason = parsed.data.stopReason;
  return Object.keys(provider).length > 0 ? provider : null;
}

function normalizeFallbackMetadata(
  value: Parameters<typeof fallbackMetadataSchema.safeParse>[0],
): MessageMetadata["fallback"] | null {
  const parsed = fallbackMetadataSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  const from = normalizeModelMetadata(parsed.data.from);
  const to = normalizeModelMetadata(parsed.data.to);
  if (!from && !to && !parsed.data.reason && parsed.data.used !== true) {
    return null;
  }
  const fallback: NonNullable<MessageMetadata["fallback"]> = { used: true };
  if (from) fallback.from = from;
  if (to) fallback.to = to;
  if (parsed.data.reason) fallback.reason = parsed.data.reason;
  return fallback;
}

function normalizeModelMetadata(
  value: Parameters<typeof modelMetadataSchema.safeParse>[0],
): ProcMessageModelMetadata | null {
  const parsed = modelMetadataSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  if (!parsed.data.provider && !parsed.data.model) {
    return null;
  }
  const model: ProcMessageModelMetadata = {};
  if (parsed.data.provider) model.provider = parsed.data.provider;
  if (parsed.data.model) model.model = parsed.data.model;
  return model;
}

export function normalizeContextState(value: JsonValue): ProcContextState | null {
  const parsed = contextStateInputSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  const inputBudgetTokens = parsed.data.inputBudgetTokens === undefined
    ? parsed.data.availableInputTokens
    : parsed.data.inputBudgetTokens;
  const remainingInputTokens = parsed.data.remainingInputTokens === undefined
    ? inputBudgetTokens === null
      ? null
      : Math.max(0, inputBudgetTokens - parsed.data.inputTokens)
    : parsed.data.remainingInputTokens;
  const confirmedInputTokens = parsed.data.confirmedInputTokens
    ?? (parsed.data.source === "provider" ? parsed.data.inputTokens : 0);
  const estimatedTrailingInputTokens = parsed.data.estimatedTrailingInputTokens
    ?? (parsed.data.source === "estimate"
      ? parsed.data.inputTokens
      : Math.max(0, parsed.data.inputTokens - confirmedInputTokens));
  const state: ProcContextState = {
    revision: parsed.data.revision ?? 0,
    provider: parsed.data.provider,
    model: parsed.data.model,
    contextWindowTokens: parsed.data.contextWindowTokens,
    maxOutputTokens: parsed.data.maxOutputTokens,
    estimatedInputTokens: parsed.data.estimatedInputTokens,
    inputTokens: parsed.data.inputTokens,
    confirmedInputTokens,
    estimatedTrailingInputTokens,
    inputBudgetTokens,
    remainingInputTokens,
    availableInputTokens: inputBudgetTokens,
    pressure: parsed.data.pressure,
    level: parsed.data.level,
    source: parsed.data.source,
    updatedAt: parsed.data.updatedAt,
  };
  if (parsed.data.runId !== undefined) state.runId = parsed.data.runId;
  if (parsed.data.messageCount !== undefined) state.messageCount = parsed.data.messageCount;
  if (parsed.data.lastMessageId !== undefined) state.lastMessageId = parsed.data.lastMessageId;
  if (parsed.data.reasoning !== undefined) state.reasoning = parsed.data.reasoning;
  if (parsed.data.outputTokens !== undefined) state.outputTokens = parsed.data.outputTokens;
  if (parsed.data.totalTokens !== undefined) state.totalTokens = parsed.data.totalTokens;
  if (parsed.data.usage !== undefined) state.usage = parsed.data.usage;
  if (parsed.data.historyUsage !== undefined) state.historyUsage = parsed.data.historyUsage;
  return state;
}

export function normalizeUsageState(
  value: Parameters<typeof usageStateInputSchema.safeParse>[0],
): ProcUsageState | null {
  const parsed = usageStateInputSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  const inputTokens = parsed.data.inputTokens ?? parsed.data.input ?? 0;
  const outputTokens = parsed.data.outputTokens ?? parsed.data.output ?? 0;
  const cacheReadTokens = parsed.data.cacheReadTokens ?? parsed.data.cacheRead ?? 0;
  const cacheWriteTokens = parsed.data.cacheWriteTokens ?? parsed.data.cacheWrite ?? 0;
  const usage: ProcUsageState = {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: parsed.data.totalTokens
      ?? inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    cost: normalizeUsageCost(parsed.data.cost),
  };
  if (parsed.data.generations !== undefined) usage.generations = parsed.data.generations;
  if (parsed.data.costIncomplete === true) usage.costIncomplete = true;
  if (parsed.data.updatedAt !== undefined) usage.updatedAt = parsed.data.updatedAt;
  return usage;
}

function normalizeUsageCost(
  value: Parameters<typeof usageCostInputSchema.safeParse>[0],
): ProcUsageCost | null {
  const parsed = usageCostInputSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  const input = parsed.data.input ?? 0;
  const output = parsed.data.output ?? 0;
  const cacheRead = parsed.data.cacheRead ?? 0;
  const cacheWrite = parsed.data.cacheWrite ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: parsed.data.total ?? input + output + cacheRead + cacheWrite,
    currency: "USD",
    source: parsed.data.source ?? "provider",
  };
}

export function mergeUsageStates(
  current: ProcUsageState | null,
  next: ProcUsageState,
): ProcUsageState {
  const baseline = current ?? emptyUsageState();
  const cost = mergeUsageCosts(baseline.cost, next.cost);
  const currentGenerations = baseline.generations ?? 0;
  const nextGenerations = next.generations ?? 1;

  const merged: ProcUsageState = {
    inputTokens: baseline.inputTokens + next.inputTokens,
    outputTokens: baseline.outputTokens + next.outputTokens,
    cacheReadTokens: baseline.cacheReadTokens + next.cacheReadTokens,
    cacheWriteTokens: baseline.cacheWriteTokens + next.cacheWriteTokens,
    totalTokens: baseline.totalTokens + next.totalTokens,
    cost,
    generations: currentGenerations + nextGenerations,
    updatedAt: Date.now(),
  };
  if (isMergedUsageCostIncomplete(current, next)) merged.costIncomplete = true;
  return merged;
}

function isMergedUsageCostIncomplete(
  current: ProcUsageState | null,
  next: ProcUsageState,
): boolean {
  return current?.costIncomplete === true
    || next.costIncomplete === true
    || next.cost === null
    || current?.cost === null;
}

function mergeUsageCosts(
  current: ProcUsageCost | null,
  next: ProcUsageCost | null,
): ProcUsageCost | null {
  if (!current && !next) {
    return null;
  }
  if (!current) {
    return next === null ? null : cloneUsageCost(next);
  }
  if (!next) {
    return cloneUsageCost(current);
  }
  return {
    input: current.input + next.input,
    output: current.output + next.output,
    cacheRead: current.cacheRead + next.cacheRead,
    cacheWrite: current.cacheWrite + next.cacheWrite,
    total: current.total + next.total,
    currency: "USD",
    source: current.source === next.source ? current.source : "mixed",
  };
}

function cloneUsageCost(cost: ProcUsageCost): ProcUsageCost {
  return {
    input: cost.input,
    output: cost.output,
    cacheRead: cost.cacheRead,
    cacheWrite: cost.cacheWrite,
    total: cost.total,
    currency: "USD",
    source: cost.source,
  };
}

export function emptyUsageState(): ProcUsageState {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    cost: null,
    generations: 0,
  };
}

export function usageStateToPiUsage(usage: ProcUsageState | null | undefined): AssistantMessage["usage"] {
  const normalized = usage ?? emptyUsageState();
  const cost = usageCostOrZero(normalized.cost);
  return {
    input: normalized.inputTokens,
    output: normalized.outputTokens,
    cacheRead: normalized.cacheReadTokens,
    cacheWrite: normalized.cacheWriteTokens,
    totalTokens: normalized.totalTokens,
    cost,
  };
}

function usageCostOrZero(cost: ProcUsageCost | null): NonNullable<AssistantMessage["usage"]>["cost"] {
  if (!cost) {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  }
  return {
    input: cost.input,
    output: cost.output,
    cacheRead: cost.cacheRead,
    cacheWrite: cost.cacheWrite,
    total: cost.total,
  };
}

export function normalizeAssistantStopReason(
  value: string | undefined,
): AssistantMessage["stopReason"] {
  return value === "length" || value === "toolUse" || value === "error" || value === "aborted"
    ? value
    : "stop";
}
