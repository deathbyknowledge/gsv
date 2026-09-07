import { z } from "zod";
import type { AiConfigResult } from "@humansandmachines/gsv/protocol";
import type { AssistantMessage, TextContent, ThinkingContent, ToolCall } from "@earendil-works/pi-ai";
import {
  parseRunControlCommand, type RunControlCommand, type RunControlCommandParseResult,
} from "./run-control-command";
import { SEND_TOOL, sendToolArgsSchema } from "./internal/schemas";

/** A run-control action the model took: a Shell `message send` or `yield`, or a Send tool call. */
type RunControlCall = {
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
  runControlCalls: RunControlCall[];
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
  const offered = new Set(offeredToolNames);
  // Send is run control only where it was offered; a bounded IPC run never offers it, so a fabricated call is unoffered
  const runControlCalls = returnedToolCalls.flatMap((toolCall) => {
    const call = parseRunControlShellCall(toolCall)
      ?? (offered.has(SEND_TOOL.name) ? parseRunControlSendCall(toolCall) : null);
    return call ? [call] : [];
  });
  const runControlIds = new Set(runControlCalls.map(({ toolCall }) => toolCall.id));
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

function parseRunControlShellCall(toolCall: ToolCall): RunControlCall | null {
  if (toolCall.name !== "Shell") return null;
  const args = terminalShellToolArgsSchema.safeParse(toolCall.arguments);
  if (!args.success) return null;
  const parsed = parseRunControlCommand(args.data.input);
  return parsed ? { toolCall, parsed } : null;
}

/**
 * The Send tool is the same command as a tool call. Text alone sends and the
 * run continues; text with yield sends and ends; yield alone ends, or sends
 * staged media and ends. Whether an empty text is a message is decided where
 * the staged media is known.
 */
function parseRunControlSendCall(toolCall: ToolCall): RunControlCall | null {
  if (toolCall.name !== SEND_TOOL.name) return null;
  const args = sendToolArgsSchema.safeParse(toolCall.arguments);
  if (!args.success) {
    return {
      toolCall,
      parsed: {
        ok: false,
        action: "message",
        error: "Send accepts text (a string) and yield (a boolean) and nothing else",
      },
    };
  }
  const text = args.data.text ?? "";
  const finish = args.data.yield === true;
  const command: RunControlCommand = finish && !text.trim()
    ? { action: "message", text: "", finish: true, emptyMeansYield: true }
    : { action: "message", text, finish };
  return { toolCall, parsed: { ok: true, command } };
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
