/** Internal Process messages primitives. */

import {
  type AiConfigResult, type AiTextMessage, type AiTextTool, type JsonObject, type ProcHistoryOverflowPolicy,
  type ProcToolResultOutcome, type ProcUsageCostSource, type ProcUsageState, jsonObjectSchema, jsonValueSchema,
} from "@humansandmachines/gsv/protocol";
import type { AssistantMessage, Message, Tool } from "@earendil-works/pi-ai";
import { type MessageMetadata, normalizeMessageMetadata } from "../store";
import type { ResponseFrame } from "../../protocol/frames";
import type { ResultOf } from "../../syscalls";
import {
  TOOL_EXECUTION_DENIED_BY_USER_MESSAGE, USER_INTERRUPTED_TOOL_MESSAGE, USER_SUPERSEDED_TOOL_MESSAGE,
} from "./lifecycle";
import {
  assistantMessageDiagnosticsSchema, nonEmptyStringSchema, protocolStopReasonSchema, storedStringArraySchema,
} from "./schemas";
import { hasWorkersAiModelPricing, isWorkersAiProvider } from "../../inference/workers-ai";

export function normalizeOptionalString(
  value: Parameters<typeof nonEmptyStringSchema.safeParse>[0],
): string | undefined {
  const result = nonEmptyStringSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

export function adaptGeneratedAssistantMessage(
  message: ResultOf<"ai.text.generate">["message"],
): AssistantMessage {
  const adapted: AssistantMessage = {
    role: "assistant",
    content: message.content,
    api: message.api,
    provider: message.provider,
    model: message.model,
    usage: message.usage,
    stopReason: message.stopReason,
    timestamp: message.timestamp ?? Date.now(),
  };
  if (message.responseModel) adapted.responseModel = message.responseModel;
  if (message.responseId) adapted.responseId = message.responseId;
  if (message.errorMessage) adapted.errorMessage = message.errorMessage;
  const diagnostics = assistantMessageDiagnosticsSchema.safeParse(message.diagnostics);
  if (diagnostics.success) {
    adapted.diagnostics = diagnostics.data;
  }
  return adapted;
}

export function adaptContextMessage(message: Message): AiTextMessage {
  if (message.role === "user") {
    return {
      role: "user",
      content: message.content,
      timestamp: message.timestamp,
    };
  }
  if (message.role === "toolResult") {
    return {
      role: "toolResult",
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      content: message.content,
      details: message.details,
      isError: message.isError,
      timestamp: message.timestamp,
    };
  }
  const content = message.content.map((block) => {
    if (block.type !== "toolCall") {
      return block;
    }
    return {
      ...block,
      arguments: jsonObjectSchema.parse(block.arguments),
    };
  });
  const adapted: AiTextMessage = {
    role: "assistant",
    content,
    api: message.api,
    provider: message.provider,
    model: message.model,
    usage: message.usage,
    stopReason: protocolStopReasonSchema.parse(message.stopReason),
    timestamp: message.timestamp,
  };
  if (message.responseModel) adapted.responseModel = message.responseModel;
  if (message.responseId) adapted.responseId = message.responseId;
  if (message.diagnostics) adapted.diagnostics = message.diagnostics;
  if (message.errorMessage) adapted.errorMessage = message.errorMessage;
  return adapted;
}

export function adaptContextTool(tool: Tool): AiTextTool {
  return {
    name: tool.name,
    description: tool.description,
    parameters: jsonObjectSchema.parse(tool.parameters),
  };
}

export function normalizeToolResultOutcome(
  value: Parameters<typeof jsonValueSchema.safeParse>[0],
  isError: boolean,
  content: string,
): ProcToolResultOutcome {
  if (
    value === "completed"
    || value === "failed"
    || value === "cancelled"
    || value === "denied"
  ) {
    return value;
  }
  if (!isError) {
    return "completed";
  }

  const reason = content.startsWith("Error: ")
    ? content.slice("Error: ".length)
    : content;
  if (reason === TOOL_EXECUTION_DENIED_BY_USER_MESSAGE) {
    return "denied";
  }
  if (reason === USER_INTERRUPTED_TOOL_MESSAGE || reason === USER_SUPERSEDED_TOOL_MESSAGE) {
    return "cancelled";
  }
  return "failed";
}

export function parseOptionalJsonObject(
  value: Parameters<typeof jsonObjectSchema.safeParse>[0],
): JsonObject | null {
  const result = jsonObjectSchema.safeParse(value);
  return result.success ? result.data : null;
}

export async function cancelResponseBody(frame: ResponseFrame, reason: string): Promise<void> {
  if (frame.ok && frame.body) {
    await frame.body.stream.cancel(reason).catch(() => { });
  }
}

export function buildAssistantMessageMetadata(
  response: AssistantMessage,
  config: AiConfigResult,
  fallback?: MessageMetadata["fallback"],
  contextEpochId?: string,
  generationContextId?: string,
): MessageMetadata | undefined {
  const usage = assistantUsageToProcUsageState(
    response.usage,
    resolveUsageCostSource(response, config),
  );
  const metadata = normalizeMessageMetadata({
    contextEpochId,
    generationContextId,
    provider: {
      api: response.api,
      provider: response.provider || config.provider,
      model: response.model || config.model,
      responseModel: response.responseModel,
      responseId: response.responseId,
      stopReason: response.stopReason,
    },
    fallback,
    usage,
  });
  return metadata ?? undefined;
}

export function modelMetadataFromAiConfig(config: AiConfigResult): NonNullable<MessageMetadata["fallback"]>["from"] {
  return {
    provider: config.provider,
    model: config.model,
  };
}

function assistantUsageToProcUsageState(
  usage: AssistantMessage["usage"] | undefined,
  costSource: ProcUsageCostSource | null,
): ProcUsageState | undefined {
  if (!usage) {
    return undefined;
  }
  const inputTokens = nonNegativeNumberOrZero(usage.input);
  const outputTokens = nonNegativeNumberOrZero(usage.output);
  const cacheReadTokens = nonNegativeNumberOrZero(usage.cacheRead);
  const cacheWriteTokens = nonNegativeNumberOrZero(usage.cacheWrite);
  const componentTotal = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  const totalTokens = componentTotal > 0
    ? componentTotal
    : nonNegativeNumberOrZero(usage.totalTokens);
  const cost = costSource ? assistantUsageCost(usage, costSource) : null;
  const state: ProcUsageState = {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    cost,
    updatedAt: Date.now(),
  };
  if (!costSource) state.costIncomplete = true;
  return state;
}

function assistantUsageCost(
  usage: NonNullable<AssistantMessage["usage"]>,
  source: ProcUsageCostSource,
): NonNullable<ProcUsageState["cost"]> {
  const input = nonNegativeNumberOrZero(usage.cost?.input);
  const output = nonNegativeNumberOrZero(usage.cost?.output);
  const cacheRead = nonNegativeNumberOrZero(usage.cost?.cacheRead);
  const cacheWrite = nonNegativeNumberOrZero(usage.cost?.cacheWrite);
  const componentTotal = input + output + cacheRead + cacheWrite;
  const reportedTotal = normalizeNonNegativeNumber(usage.cost?.total);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: reportedTotal === null ? componentTotal : reportedTotal,
    currency: "USD",
    source,
  };
}

function nonNegativeNumberOrZero(value: number | undefined): number {
  return normalizeNonNegativeNumber(value) ?? 0;
}

function isNonEmptyDefinedString(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

function isPositiveFiniteNumber(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

function resolveUsageCostSource(
  response: AssistantMessage,
  config: AiConfigResult,
): ProcUsageCostSource | null {
  if (isWorkersAiProvider(config.provider) || isWorkersAiProvider(response.provider)) {
    const pricedModel = [response.model, response.responseModel, config.model]
      .filter(isNonEmptyDefinedString)
      .some((model) => hasWorkersAiModelPricing(model));
    return pricedModel || usageCostHasValue(response.usage) ? "model-pricing" : null;
  }
  return usageCostHasValue(response.usage) || !usageHasPositiveTokens(response.usage)
    ? "provider"
    : null;
}

function usageCostHasValue(usage: AssistantMessage["usage"] | undefined): boolean {
  if (!usage) {
    return false;
  }
  return [
    usage.cost?.input,
    usage.cost?.output,
    usage.cost?.cacheRead,
    usage.cost?.cacheWrite,
    usage.cost?.total,
  ].some(isPositiveFiniteNumber);
}

function usageHasPositiveTokens(usage: AssistantMessage["usage"] | undefined): boolean {
  if (!usage) {
    return false;
  }
  return [
    usage.input,
    usage.output,
    usage.cacheRead,
    usage.cacheWrite,
    usage.totalTokens,
  ].some(isPositiveFiniteNumber);
}

function normalizeNonNegativeNumber(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : null;
}

export function parseStoredStringArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = storedStringArraySchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

export function isNonNegativeInteger(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value >= 0;
}

export function isPositiveInteger(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value > 0;
}

export function isHistoryOverflowPolicy(value: string | undefined): value is ProcHistoryOverflowPolicy {
  return value === "auto-compact" || value === "fail";
}
