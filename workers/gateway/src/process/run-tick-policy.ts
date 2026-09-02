import { z } from "zod";
import type { AiConfigResult } from "@humansandmachines/gsv/protocol";
import type { AssistantMessage, TextContent, ThinkingContent, ToolCall } from "@earendil-works/pi-ai";
import { parseRunControlCommand, type RunControlCommandParseResult } from "./run-control-command";

type RunControlShellCall = {
  toolCall: ToolCall;
  parsed: RunControlCommandParseResult;
};

type AssistantTurnKind =
  | "run-control"
  | "invalid-run-control"
  | "tools"
  | "unoffered-tools"
  | "terminal";

export type AssistantTurnClassification = {
  kind: AssistantTurnKind;
  text: string;
  thinking: ThinkingContent[];
  returnedToolCalls: ToolCall[];
  runControlCalls: RunControlShellCall[];
  toolCalls: ToolCall[];
  unofferedToolCalls: ToolCall[];
};

const terminalShellToolArgsSchema = z
  .object({
    input: z.string(),
    target: z.enum(["gsv", "gateway"]).optional(),
    cwd: z.string().optional(),
    timeout: z.number().optional(),
  })
  .strict();

export function classifyAssistantTurn(
  response: AssistantMessage,
  offeredToolNames: readonly string[],
): AssistantTurnClassification {
  const text = response.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("");
  const thinking = response.content.filter(
    (block): block is ThinkingContent => block.type === "thinking",
  );
  const returnedToolCalls = response.content.filter(
    (block): block is ToolCall => block.type === "toolCall",
  );
  const runControlCalls = returnedToolCalls.flatMap((toolCall) => {
    const call = parseRunControlShellCall(toolCall);
    return call ? [call] : [];
  });
  const runControlIds = new Set(runControlCalls.map(({ toolCall }) => toolCall.id));
  const offered = new Set(offeredToolNames);
  const toolCalls = returnedToolCalls.filter(
    (toolCall) => offered.has(toolCall.name) && !runControlIds.has(toolCall.id),
  );
  const unofferedToolCalls = returnedToolCalls.filter(
    (toolCall) => !offered.has(toolCall.name) && !runControlIds.has(toolCall.id),
  );
  const invalidRunControl =
    runControlCalls.length > 1 ||
    (runControlCalls.length === 1 && (toolCalls.length > 0 || unofferedToolCalls.length > 0));
  const kind: AssistantTurnKind = invalidRunControl
    ? "invalid-run-control"
    : runControlCalls.length === 1
      ? "run-control"
      : toolCalls.length > 0
        ? "tools"
        : unofferedToolCalls.length > 0
          ? "unoffered-tools"
          : "terminal";
  return {
    kind,
    text,
    thinking,
    returnedToolCalls,
    runControlCalls,
    toolCalls,
    unofferedToolCalls,
  };
}

export function nextAiConfigFallback(
  primary: AiConfigResult,
  current: AiConfigResult,
  fallbacks: NonNullable<AiConfigResult["fallbacks"]>,
  startIndex: number,
): { config: AiConfigResult; nextIndex: number } | null {
  for (let index = startIndex; index < fallbacks.length; index += 1) {
    const config = aiConfigWithFallback(primary, fallbacks[index]);
    if (!isSameAiRuntimeModelStack(current, config)) {
      return { config, nextIndex: index + 1 };
    }
  }
  return null;
}

function parseRunControlShellCall(toolCall: ToolCall): RunControlShellCall | null {
  if (toolCall.name !== "Shell") return null;
  const args = terminalShellToolArgsSchema.safeParse(toolCall.arguments);
  if (!args.success) return null;
  const parsed = parseRunControlCommand(args.data.input);
  return parsed ? { toolCall, parsed } : null;
}

function aiConfigWithFallback(
  primary: AiConfigResult,
  fallback: NonNullable<AiConfigResult["fallbacks"]>[number],
): AiConfigResult {
  const {
    fallbacks: _fallbacks,
    provider: _provider,
    model: _model,
    apiKey: _apiKey,
    baseUrl: _baseUrl,
    providerStyle: _providerStyle,
    transportTarget: _transportTarget,
    openAiCodex: _openAiCodex,
    reasoning: _reasoning,
    maxTokens: _maxTokens,
    contextWindowTokens: _contextWindowTokens,
    contextWindowSource: _contextWindowSource,
    generationTimeoutMs: _generationTimeoutMs,
    generationStreaming: _generationStreaming,
    ...base
  } = primary;
  const config: AiConfigResult = {
    ...base,
    provider: fallback.provider,
    model: fallback.model,
    apiKey: fallback.apiKey,
    providerStyle: fallback.providerStyle,
    transportTarget: fallback.transportTarget,
    reasoning: fallback.reasoning,
    maxTokens: fallback.maxTokens,
    contextWindowTokens: fallback.contextWindowTokens,
    contextWindowSource: fallback.contextWindowSource,
    generationTimeoutMs: fallback.generationTimeoutMs,
    generationStreaming: fallback.generationStreaming,
  };
  if (fallback.baseUrl) config.baseUrl = fallback.baseUrl;
  if (fallback.openAiCodex) config.openAiCodex = fallback.openAiCodex;
  return config;
}

function isSameAiRuntimeModelStack(left: AiConfigResult, right: AiConfigResult): boolean {
  return (
    left.provider.trim().toLowerCase() === right.provider.trim().toLowerCase() &&
    left.model.trim().toLowerCase() === right.model.trim().toLowerCase() &&
    left.apiKey === right.apiKey &&
    (left.baseUrl ?? "").trim() === (right.baseUrl ?? "").trim() &&
    (left.providerStyle ?? "auto").trim().toLowerCase() ===
      (right.providerStyle ?? "auto").trim().toLowerCase() &&
    (left.transportTarget ?? "gsv").trim() === (right.transportTarget ?? "gsv").trim() &&
    (left.openAiCodex?.accountId ?? "") === (right.openAiCodex?.accountId ?? "")
  );
}
