import {
  calculateCost,
  createAssistantMessageEventStream,
  createModels,
  createProvider,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type ProviderStreams,
  type SimpleStreamOptions,
  type TextContent,
  type ThinkingContent,
  type Tool,
  type ToolCall,
} from "@earendil-works/pi-ai";
import {
  jsonObjectSchema,
  jsonValueSchema,
  type JsonObject,
  type JsonValue,
} from "@humansandmachines/gsv/protocol";
import { Stream } from "openai/core/streaming.js";
import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { z } from "zod";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { convertMessages } from "@earendil-works/pi-ai/api/openai-completions";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import {
  convertResponsesMessages,
  convertResponsesTools,
  processResponsesStream,
} from "@earendil-works/pi-ai/api/openai-responses-shared";
import { DEFAULT_TEXT_GENERATION_MAX_TOKENS } from "./default-models";

export type CustomProviderStyle =
  | "openai-chat-completions"
  | "openai-responses"
  | "anthropic-messages";

export type CustomProviderGenerationRequest = {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  providerStyle?: string;
  fetch?: typeof fetch;
  contextWindowTokens?: number | null;
  maxTokens: number;
  context: Context;
  options?: SimpleStreamOptions;
};

type RoutedRequestInit = RequestInit & { timeoutMs?: number };

type OpenAIChatFunction = {
  name?: string | null;
  arguments?: string;
};

type OpenAIChatToolCallDelta = {
  index?: number;
  id?: string | null;
  function?: OpenAIChatFunction;
};

type OpenAIChatDelta = {
  content?: string | null;
  reasoning_content?: string | null;
  reasoning?: string;
  reasoning_text?: string;
  tool_calls?: OpenAIChatToolCallDelta[] | null;
};

type OpenAIChatChoice = {
  finish_reason?: string | null;
  delta?: OpenAIChatDelta;
};

type OpenAIUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
};

type OpenAIChatChunk = {
  id?: string;
  model?: string;
  usage?: OpenAIUsage | null;
  choices?: OpenAIChatChoice[];
};

type OpenAIChatTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Tool["parameters"];
    strict: false;
  };
};

type OpenAIChatPayload = {
  model: string;
  messages: ReturnType<typeof convertMessages>;
  stream: true;
  max_tokens: number;
  stream_options?: { include_usage: true };
  tools?: OpenAIChatTool[];
};

type OpenAIResponsesPayload = {
  model: string;
  input: ReturnType<typeof convertResponsesMessages>;
  stream: true;
  store: false;
  max_output_tokens: number;
  tools?: ReturnType<typeof convertResponsesTools>;
  reasoning?: {
    effort: NonNullable<SimpleStreamOptions["reasoning"]>;
    summary: "auto";
  };
  include?: ["reasoning.encrypted_content"];
};

type CustomProviderPayload = OpenAIChatPayload | OpenAIResponsesPayload;
type CustomProviderModel =
  | Model<"openai-completions">
  | Model<"openai-responses">
  | Model<"anthropic-messages">;

const openAIChatFunctionSchema = z.object({
  name: z.string().nullable().optional(),
  arguments: z.string().optional(),
});
const openAIChatToolCallDeltaSchema = z.object({
  index: z.number().int().nonnegative().optional(),
  id: z.string().nullable().optional(),
  function: openAIChatFunctionSchema.optional(),
});
const openAIChatDeltaSchema = z.object({
  content: z.string().nullable().optional(),
  reasoning_content: z.string().nullable().optional(),
  reasoning: z.string().optional(),
  reasoning_text: z.string().optional(),
  tool_calls: z.array(openAIChatToolCallDeltaSchema).nullable().optional(),
});
const openAIChatChoiceSchema = z.object({
  finish_reason: z.string().nullable().optional(),
  delta: openAIChatDeltaSchema.optional(),
});
const openAIUsageSchema = z.object({
  prompt_tokens: z.number().finite().optional(),
  completion_tokens: z.number().finite().optional(),
  prompt_cache_hit_tokens: z.number().finite().optional(),
  prompt_tokens_details: z.object({
    cached_tokens: z.number().finite().optional(),
    cache_write_tokens: z.number().finite().optional(),
  }).optional(),
});
const openAIChatChunkSchema = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  usage: openAIUsageSchema.nullable().optional(),
  choices: z.array(openAIChatChoiceSchema).optional(),
});
const CUSTOM_PROVIDER_ID = "custom";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;

export function shouldUseCustomProvider(input: {
  provider: string;
  baseUrl?: string;
  providerStyle?: string;
}): boolean {
  if (normalizeOptionalText(input.baseUrl)) {
    return true;
  }
  if (normalizeCustomProviderStyle(input.providerStyle)) {
    return true;
  }
  return input.provider.trim().toLowerCase() === CUSTOM_PROVIDER_ID;
}

export function streamWithCustomProvider(
  request: CustomProviderGenerationRequest,
): AssistantMessageEventStream {
  if (shouldUseFetchImplementation(request)) {
    return streamWithCustomFetch(request);
  }
  const { models, model } = buildCustomProviderModels(request);
  return models.streamSimple(model, request.context, buildCustomProviderOptions(request));
}

export function completeWithCustomProvider(
  request: CustomProviderGenerationRequest,
): Promise<AssistantMessage> {
  if (shouldUseFetchImplementation(request)) {
    return streamWithCustomFetch(request).result();
  }
  const { models, model } = buildCustomProviderModels(request);
  return models.completeSimple(model, request.context, buildCustomProviderOptions(request));
}

function shouldUseRoutedFetch(request: CustomProviderGenerationRequest): boolean {
  return Boolean(request.fetch && request.fetch !== fetch);
}

function shouldUseFetchImplementation(request: CustomProviderGenerationRequest): boolean {
  const provider = normalizeProviderId(request.provider);
  const style = resolveCustomProviderStyle(provider, request.providerStyle);
  return style === "openai-chat-completions" || style === "openai-responses" || shouldUseRoutedFetch(request);
}

function streamWithCustomFetch(
  request: CustomProviderGenerationRequest,
): AssistantMessageEventStream {
  const fetchImpl = request.fetch ?? fetch;
  const provider = normalizeProviderId(request.provider);
  const style = resolveCustomProviderStyle(provider, request.providerStyle);
  const baseUrl = resolveCustomBaseUrl(provider, style, request.baseUrl);
  if (style === "anthropic-messages") {
    throw new Error("Anthropic-compatible custom providers do not support fetch-based custom transport yet");
  }
  if (style === "openai-responses") {
    const model = customModelForRequest(request, provider, style, baseUrl);
    return streamOpenAIResponsesWithFetch(fetchImpl, model, request);
  }
  const model = customModelForRequest(request, provider, style, baseUrl);
  return streamOpenAICompletionsWithFetch(fetchImpl, model, request);
}

function streamOpenAICompletionsWithFetch(
  fetchImpl: typeof fetch,
  model: Model<"openai-completions">,
  request: CustomProviderGenerationRequest,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  void (async () => {
    const output = emptyAssistantMessage(model);
    try {
      const compat = resolvedOpenAICompletionsCompat(model);
      const payload: OpenAIChatPayload = {
        model: model.id,
        messages: convertMessages(model, request.context, compat),
        stream: true,
        max_tokens: request.options?.maxTokens ?? request.maxTokens,
      };
      if (supportsOpenAIChatStreamingUsage(model)) {
        payload.stream_options = { include_usage: true };
      }
      if (request.context.tools && request.context.tools.length > 0) {
        payload.tools = convertChatTools(request.context.tools);
      }
      const response = await postJsonSse(fetchImpl, `${model.baseUrl}/chat/completions`, payload, request);
      stream.push({ type: "start", partial: output });
      await consumeOpenAICompletionsEvents(response, output, stream, model, request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushStreamError(stream, output, request, message);
    }
  })();
  return stream;
}

function streamOpenAIResponsesWithFetch(
  fetchImpl: typeof fetch,
  model: Model<"openai-responses">,
  request: CustomProviderGenerationRequest,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  void (async () => {
    const output = emptyAssistantMessage(model);
    try {
      const payload: OpenAIResponsesPayload = {
        model: model.id,
        input: convertResponsesMessages(model, request.context, new Set([model.provider, "openai", "opencode"])),
        stream: true,
        store: false,
        max_output_tokens: request.options?.maxTokens ?? request.maxTokens,
      };
      if (request.context.tools && request.context.tools.length > 0) {
        payload.tools = convertResponsesTools(request.context.tools);
      }
      if (request.options?.reasoning) {
        payload.reasoning = {
          effort: request.options.reasoning,
          summary: "auto",
        };
        payload.include = ["reasoning.encrypted_content"];
      }
      const response = await postJsonSse(fetchImpl, `${model.baseUrl}/responses`, payload, request);
      stream.push({ type: "start", partial: output });
      const providerStream = Stream.fromSSEResponse<ResponseStreamEvent>(
        response,
        new AbortController(),
      );
      await processResponsesStream(
        providerStream,
        output,
        stream,
        model,
      );
      if (output.stopReason === "aborted" || output.stopReason === "error") {
        throw new Error(output.errorMessage || "Provider returned an error stop reason");
      }
      if (output.stopReason === "pending") {
        throw new Error("Provider response stream ended without a terminal stop reason");
      }
      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushStreamError(stream, output, request, message);
    }
  })();
  return stream;
}

export function normalizeCustomProviderStyle(
  value: string | null | undefined,
): CustomProviderStyle | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (
    normalized === "openai-chat-completions" ||
    normalized === "openai-completions" ||
    normalized === "chat-completions" ||
    normalized === "chat"
  ) {
    return "openai-chat-completions";
  }
  if (
    normalized === "openai-responses" ||
    normalized === "responses"
  ) {
    return "openai-responses";
  }
  if (
    normalized === "anthropic-messages" ||
    normalized === "anthropic" ||
    normalized === "messages"
  ) {
    return "anthropic-messages";
  }
  return null;
}

function buildCustomProviderModels(request: CustomProviderGenerationRequest) {
  const provider = normalizeProviderId(request.provider);
  const style = resolveCustomProviderStyle(provider, request.providerStyle);
  const baseUrl = resolveCustomBaseUrl(provider, style, request.baseUrl);
  const model = customModelForRequest(request, provider, style, baseUrl);
  const models = createModels();
  models.setProvider(createProvider({
    id: provider,
    name: provider === CUSTOM_PROVIDER_ID ? "Custom endpoint" : provider,
    baseUrl,
    auth: {
      apiKey: {
        name: `${provider} API key`,
        resolve: async () => ({ auth: {} }),
      },
    },
    models: [model],
    api: apiForCustomProviderStyle(style),
  }));
  return { models, model };
}

function buildCustomProviderOptions(
  request: CustomProviderGenerationRequest,
): SimpleStreamOptions {
  return {
    ...request.options,
    apiKey: normalizeOptionalText(request.apiKey),
  };
}

function customModelForRequest(
  request: CustomProviderGenerationRequest,
  provider: string,
  style: "openai-chat-completions",
  baseUrl: string,
): Model<"openai-completions">;
function customModelForRequest(
  request: CustomProviderGenerationRequest,
  provider: string,
  style: "openai-responses",
  baseUrl: string,
): Model<"openai-responses">;
function customModelForRequest(
  request: CustomProviderGenerationRequest,
  provider: string,
  style: "anthropic-messages",
  baseUrl: string,
): Model<"anthropic-messages">;
function customModelForRequest(
  request: CustomProviderGenerationRequest,
  provider: string,
  style: CustomProviderStyle,
  baseUrl: string,
): CustomProviderModel;
function customModelForRequest(
  request: CustomProviderGenerationRequest,
  provider: string,
  style: CustomProviderStyle,
  baseUrl: string,
): CustomProviderModel {
  const model = normalizeOptionalText(request.model);
  if (!model) {
    throw new Error("Custom provider model is required");
  }
  const base = {
    id: model,
    name: model,
    provider,
    baseUrl,
    reasoning: request.options?.reasoning !== undefined,
    input: ["text", "image"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: positiveInteger(request.contextWindowTokens) ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
    maxTokens: positiveInteger(request.maxTokens) ?? DEFAULT_TEXT_GENERATION_MAX_TOKENS,
  } satisfies Omit<Model<Api>, "api" | "compat">;
  if (style === "openai-chat-completions") {
    return {
      ...base,
      api: "openai-completions",
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        supportsUsageInStreaming: false,
        supportsStrictMode: false,
        maxTokensField: "max_tokens",
      },
    };
  }
  if (style === "openai-responses") {
    return {
      ...base,
      api: "openai-responses",
      compat: {
        supportsDeveloperRole: false,
        supportsLongCacheRetention: false,
      },
    };
  }
  return {
    ...base,
    api: "anthropic-messages",
    compat: {
      supportsEagerToolInputStreaming: false,
      supportsLongCacheRetention: false,
      supportsCacheControlOnTools: false,
    },
  };
}

function apiForCustomProviderStyle(style: CustomProviderStyle): ProviderStreams {
  if (style === "anthropic-messages") {
    return anthropicMessagesApi();
  }
  if (style === "openai-responses") {
    return openAIResponsesApi();
  }
  return openAICompletionsApi();
}

function emptyAssistantMessage(model: CustomProviderModel): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

async function postJsonSse(
  fetchImpl: typeof fetch,
  url: string,
  payload: CustomProviderPayload,
  request: CustomProviderGenerationRequest,
): Promise<Response> {
  const headers = new Headers({
    accept: "text/event-stream",
    "content-type": "application/json",
  });
  const apiKey = normalizeOptionalText(request.apiKey);
  if (apiKey) {
    headers.set("authorization", `Bearer ${apiKey}`);
  }
  const init: RoutedRequestInit = {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: request.options?.signal,
  };
  if (request.options?.timeoutMs !== undefined) {
    init.timeoutMs = request.options.timeoutMs;
  }
  const response = await fetchImpl(url, init);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Custom provider HTTP ${response.status}: ${body || response.statusText}`);
  }
  return response;
}

async function consumeOpenAICompletionsEvents(
  response: Response,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
  model: Model<"openai-completions">,
  request: CustomProviderGenerationRequest,
): Promise<void> {
  type StreamingToolCall = ToolCall & {
    partialArgs?: string;
    streamIndex?: number;
  };
  type StreamingBlock = TextContent | ThinkingContent | StreamingToolCall;

  // SAFETY: this function creates and exclusively mutates the assistant content
  // blocks, and each inserted block is one of the three streaming variants.
  const blocks = output.content as StreamingBlock[];
  let textBlock: TextContent | null = null;
  let thinkingBlock: ThinkingContent | null = null;
  const toolCallBlocksByIndex = new Map<number, StreamingToolCall>();
  let finishReason: string | null = null;

  const contentIndex = (block: StreamingBlock): number => blocks.indexOf(block);
  const ensureTextBlock = (): TextContent => {
    if (!textBlock) {
      textBlock = { type: "text", text: "" };
      blocks.push(textBlock);
      stream.push({ type: "text_start", contentIndex: contentIndex(textBlock), partial: output });
    }
    return textBlock;
  };
  const ensureThinkingBlock = (signature: string): ThinkingContent => {
    if (!thinkingBlock) {
      thinkingBlock = { type: "thinking", thinking: "", thinkingSignature: signature };
      blocks.push(thinkingBlock);
      stream.push({ type: "thinking_start", contentIndex: contentIndex(thinkingBlock), partial: output });
    }
    return thinkingBlock;
  };
  const ensureToolCallBlock = (
    delta: OpenAIChatToolCallDelta,
    index: number,
  ): StreamingToolCall => {
    let block = toolCallBlocksByIndex.get(index);
    if (!block) {
      const fn = delta.function;
      block = {
        type: "toolCall",
        id: delta.id ?? "",
        name: fn?.name ?? "",
        arguments: {},
        partialArgs: "",
        streamIndex: index,
      };
      toolCallBlocksByIndex.set(index, block);
      blocks.push(block);
      stream.push({ type: "toolcall_start", contentIndex: contentIndex(block), partial: output });
    }
    return block;
  };

  for await (const event of parseSseJson(response)) {
    const parsedChunk = openAIChatChunkSchema.safeParse(event);
    if (!parsedChunk.success) continue;
    const chunk: OpenAIChatChunk = parsedChunk.data;
    if (chunk.id !== undefined) {
      output.responseId ||= chunk.id;
    }
    if (chunk.model && chunk.model !== model.id) {
      output.responseModel ||= chunk.model;
    }
    if (chunk.usage) {
      output.usage = parseOpenAIUsage(chunk.usage, model);
    }
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) {
      finishReason = choice.finish_reason;
    }
    const delta = choice.delta ?? {};
    const content = delta.content;
    if (content) {
      const block = ensureTextBlock();
      block.text += content;
      stream.push({ type: "text_delta", contentIndex: contentIndex(block), delta: content, partial: output });
    }
    const reasoningFields = [
      ["reasoning_content", delta.reasoning_content],
      ["reasoning", delta.reasoning],
      ["reasoning_text", delta.reasoning_text],
    ] as const;
    for (const [key, value] of reasoningFields) {
      if (value) {
        const block = ensureThinkingBlock(key);
        block.thinking += value;
        stream.push({ type: "thinking_delta", contentIndex: contentIndex(block), delta: value, partial: output });
        break;
      }
    }
    for (const toolCall of delta.tool_calls ?? []) {
      const index = toolCall.index ?? toolCallBlocksByIndex.size;
      const block = ensureToolCallBlock(toolCall, index);
      if (!block.id && toolCall.id) {
        block.id = toolCall.id;
      }
      const fn = toolCall.function;
      if (!block.name && fn?.name) {
        block.name = fn.name;
      }
      const args = fn?.arguments ?? "";
      if (args) {
        block.partialArgs = (block.partialArgs ?? "") + args;
        block.arguments = parseJsonObject(block.partialArgs);
      }
      stream.push({ type: "toolcall_delta", contentIndex: contentIndex(block), delta: args, partial: output });
    }
  }

  for (const block of blocks) {
    const index = contentIndex(block);
    if (block.type === "text") {
      stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: output });
    } else if (block.type === "thinking") {
      stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: output });
    } else if (block.type === "toolCall") {
      block.arguments = parseJsonObject(block.partialArgs ?? "{}");
      delete block.partialArgs;
      delete block.streamIndex;
      stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: output });
    }
  }
  if (request.options?.signal?.aborted) {
    throw new Error("Request was aborted");
  }
  output.stopReason = mapOpenAIStopReason(finishReason);
  if (output.stopReason === "error" || output.stopReason === "aborted") {
    throw new Error(`Provider finish_reason: ${finishReason ?? "unknown"}`);
  }
  stream.push({
    type: "done",
    reason: output.stopReason === "length" || output.stopReason === "toolUse" ? output.stopReason : "stop",
    message: output,
  });
  stream.end();
}

async function* parseSseJson(response: Response): AsyncIterable<JsonValue> {
  if (!response.body) {
    yield* parseSseJsonText(await response.text());
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let boundary = findSseEventBoundary(buffer);
      while (boundary) {
        const event = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const parsed = parseSseJsonEvent(event);
        if (parsed !== undefined) {
          yield parsed;
        }
        boundary = findSseEventBoundary(buffer);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim().length > 0) {
      const parsed = parseSseJsonEvent(buffer);
      if (parsed !== undefined) {
        yield parsed;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function* parseSseJsonText(body: string): Iterable<JsonValue> {
  let buffer = body;
  let boundary = findSseEventBoundary(buffer);
  while (boundary) {
    const event = buffer.slice(0, boundary.index);
    buffer = buffer.slice(boundary.index + boundary.length);
    const parsed = parseSseJsonEvent(event);
    if (parsed !== undefined) {
      yield parsed;
    }
    boundary = findSseEventBoundary(buffer);
  }
  if (buffer.trim().length > 0) {
    const parsed = parseSseJsonEvent(buffer);
    if (parsed !== undefined) {
      yield parsed;
    }
  }
}

function findSseEventBoundary(buffer: string): { index: number; length: number } | null {
  const candidates = [
    { index: buffer.indexOf("\r\n\r\n"), length: 4 },
    { index: buffer.indexOf("\n\n"), length: 2 },
    { index: buffer.indexOf("\r\r"), length: 2 },
  ].filter((candidate) => candidate.index >= 0);
  candidates.sort((left, right) => left.index - right.index || right.length - left.length);
  return candidates[0] ?? null;
}

function parseSseJsonEvent(event: string): JsonValue | undefined {
  const data = event
    .split(/\r\n|\r|\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();
  if (!data || data === "[DONE]") {
    return undefined;
  }
  return jsonValueSchema.parse(JSON.parse(data));
}

function pushStreamError(
  stream: AssistantMessageEventStream,
  output: AssistantMessage,
  request: CustomProviderGenerationRequest,
  errorMessage: string,
): void {
  output.stopReason = request.options?.signal?.aborted ? "aborted" : "error";
  output.errorMessage = errorMessage;
  stream.push({ type: "error", reason: output.stopReason, error: output });
  stream.end();
}

function convertChatTools(tools: Tool[]): OpenAIChatTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: false,
    },
  }));
}

function parseOpenAIUsage(
  rawUsage: OpenAIUsage,
  model: Model<"openai-completions">,
): AssistantMessage["usage"] {
  const promptTokens = numericField(rawUsage.prompt_tokens);
  const completionTokens = numericField(rawUsage.completion_tokens);
  const promptDetails = rawUsage.prompt_tokens_details ?? {};
  const cacheRead = numericField(promptDetails.cached_tokens) || numericField(rawUsage.prompt_cache_hit_tokens);
  const cacheWrite = numericField(promptDetails.cache_write_tokens);
  const input = Math.max(0, promptTokens - cacheRead - cacheWrite);
  const usage: AssistantMessage["usage"] = {
    input,
    output: completionTokens,
    cacheRead,
    cacheWrite,
    totalTokens: input + completionTokens + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  calculateCost(model, usage);
  return usage;
}

function numericField(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? value : 0;
}

function parseJsonObject(value: string): JsonObject {
  try {
    const parsed = jsonObjectSchema.safeParse(JSON.parse(value || "{}"));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

function mapOpenAIStopReason(reason: string | null): AssistantMessage["stopReason"] {
  if (reason === "length") return "length";
  if (reason === "tool_calls" || reason === "function_call") return "toolUse";
  if (reason === "content_filter") return "error";
  return "stop";
}

function supportsOpenAIChatStreamingUsage(model: Model<"openai-completions">): boolean {
  return model.provider === "openai" && model.baseUrl === DEFAULT_OPENAI_BASE_URL;
}

function resolvedOpenAICompletionsCompat(
  model: Model<"openai-completions">,
): Parameters<typeof convertMessages>[2] {
  return {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    supportsUsageInStreaming: supportsOpenAIChatStreamingUsage(model),
    supportsFinishReason: true,
    maxTokensField: "max_tokens",
    requiresToolResultName: false,
    requiresAssistantAfterToolResult: false,
    requiresThinkingAsText: false,
    requiresReasoningContentOnAssistantMessages: false,
    thinkingFormat: "openai",
    openRouterRouting: {},
    vercelGatewayRouting: {},
    chatTemplateKwargs: {},
    chatTemplateArgs: {},
    zaiToolStream: false,
    supportsOpenAIGrammarTools: false,
    supportsStrictMode: false,
    sendSessionAffinityHeaders: false,
    sessionAffinityFormat: "openai",
    supportsLongCacheRetention: false,
  };
}

function resolveCustomProviderStyle(
  provider: string,
  providerStyle: string | undefined,
): CustomProviderStyle {
  const configured = normalizeCustomProviderStyle(providerStyle);
  if (configured) {
    return configured;
  }
  return provider === "anthropic" ? "anthropic-messages" : "openai-chat-completions";
}

function resolveCustomBaseUrl(
  provider: string,
  style: CustomProviderStyle,
  baseUrl: string | undefined,
): string {
  const configured = normalizeBaseUrl(baseUrl);
  if (configured) {
    return configured;
  }
  if (provider === "openai") {
    return DEFAULT_OPENAI_BASE_URL;
  }
  if (provider === "openrouter") {
    return DEFAULT_OPENROUTER_BASE_URL;
  }
  if (provider === "anthropic") {
    return DEFAULT_ANTHROPIC_BASE_URL;
  }
  if (provider === CUSTOM_PROVIDER_ID) {
    throw new Error("Custom provider base URL is required");
  }
  if (style === "anthropic-messages") {
    return DEFAULT_ANTHROPIC_BASE_URL;
  }
  return DEFAULT_OPENAI_BASE_URL;
}

function normalizeBaseUrl(value: string | undefined): string | null {
  const normalized = normalizeOptionalText(value);
  if (!normalized) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error("Custom provider base URL must be an absolute HTTP(S) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Custom provider base URL must use HTTP or HTTPS");
  }
  return url.toString().replace(/\/+$/, "");
}

function normalizeProviderId(value: string): string {
  const normalized = normalizeOptionalText(value)?.toLowerCase();
  return normalized || CUSTOM_PROVIDER_ID;
}

function normalizeOptionalText(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function positiveInteger(value: number | null | undefined): number | null {
  return value !== null && value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}
