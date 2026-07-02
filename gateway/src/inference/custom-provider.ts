import {
  calculateCost,
  createModels,
  createProvider,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
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
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { convertMessages } from "@earendil-works/pi-ai/api/openai-completions";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import {
  convertResponsesMessages,
  convertResponsesTools,
  processResponsesStream,
} from "@earendil-works/pi-ai/api/openai-responses-shared";

class RoutedAssistantMessageEventStream implements AsyncIterable<AssistantMessageEvent> {
  private queue: AssistantMessageEvent[] = [];
  private waiters: Array<(value: IteratorResult<AssistantMessageEvent>) => void> = [];
  private done = false;
  private resolveResult!: (message: AssistantMessage) => void;
  private readonly resultPromise = new Promise<AssistantMessage>((resolve) => {
    this.resolveResult = resolve;
  });

  push(event: AssistantMessageEvent): void {
    if (this.done) return;
    if (event.type === "done" || event.type === "error") {
      this.done = true;
      this.resolveResult(event.type === "done" ? event.message : event.error);
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: event, done: false });
    } else {
      this.queue.push(event);
    }
  }

  end(): void {
    this.done = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ value: undefined as never, done: true });
    }
  }

  result(): Promise<AssistantMessage> {
    return this.resultPromise;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
    while (true) {
      const queued = this.queue.shift();
      if (queued) {
        yield queued;
        continue;
      }
      if (this.done) {
        return;
      }
      const next = await new Promise<IteratorResult<AssistantMessageEvent>>((resolve) => {
        this.waiters.push(resolve);
      });
      if (next.done) {
        return;
      }
      yield next.value;
    }
  }
}

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
  const model = customModelForRequest(request, provider, style, baseUrl);
  if (style === "anthropic-messages") {
    throw new Error("Anthropic-compatible custom providers do not support fetch-based custom transport yet");
  }
  return style === "openai-responses"
    ? streamOpenAIResponsesWithFetch(fetchImpl, model as Model<"openai-responses">, request)
    : streamOpenAICompletionsWithFetch(fetchImpl, model as Model<"openai-completions">, request);
}

function streamOpenAICompletionsWithFetch(
  fetchImpl: typeof fetch,
  model: Model<"openai-completions">,
  request: CustomProviderGenerationRequest,
): AssistantMessageEventStream {
  const stream = new RoutedAssistantMessageEventStream();
  void (async () => {
    const output = emptyAssistantMessage(model);
    try {
      const compat = resolvedOpenAICompletionsCompat();
      const payload: Record<string, unknown> = {
        model: model.id,
        messages: convertMessages(model, request.context, compat as never),
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: request.options?.maxTokens ?? request.maxTokens,
      };
      if (request.context.tools && request.context.tools.length > 0) {
        payload.tools = convertChatTools(request.context.tools);
      }
      const response = await postJsonSse(fetchImpl, `${model.baseUrl}/chat/completions`, payload, request);
      stream.push({ type: "start", partial: output });
      await consumeOpenAICompletionsEvents(response, output, stream, model, request);
    } catch (error) {
      pushStreamError(stream, output, request, error);
    }
  })();
  return stream as unknown as AssistantMessageEventStream;
}

function streamOpenAIResponsesWithFetch(
  fetchImpl: typeof fetch,
  model: Model<"openai-responses">,
  request: CustomProviderGenerationRequest,
): AssistantMessageEventStream {
  const stream = new RoutedAssistantMessageEventStream();
  void (async () => {
    const output = emptyAssistantMessage(model);
    try {
      const payload: Record<string, unknown> = {
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
      await processResponsesStream(
        parseSseJson(response) as AsyncIterable<never>,
        output,
        stream as never,
        model,
      );
      if (output.stopReason === "aborted" || output.stopReason === "error") {
        throw new Error(output.errorMessage || "Provider returned an error stop reason");
      }
      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      pushStreamError(stream, output, request, error);
    }
  })();
  return stream as unknown as AssistantMessageEventStream;
}

export function normalizeCustomProviderStyle(value: unknown): CustomProviderStyle | null {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
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

function buildCustomProviderModels(request: CustomProviderGenerationRequest): {
  models: ReturnType<typeof createModels>;
  model: Model<Api>;
} {
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
  style: CustomProviderStyle,
  baseUrl: string,
): Model<Api> {
  const model = normalizeOptionalText(request.model);
  if (!model) {
    throw new Error("Custom provider model is required");
  }
  return {
    id: model,
    name: model,
    api: apiIdForCustomProviderStyle(style),
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
    maxTokens: positiveInteger(request.maxTokens) ?? 8192,
    ...(compatForCustomProviderStyle(style) ? { compat: compatForCustomProviderStyle(style) } : {}),
  } as Model<Api>;
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

function apiIdForCustomProviderStyle(style: CustomProviderStyle): Api {
  if (style === "anthropic-messages") {
    return "anthropic-messages";
  }
  if (style === "openai-responses") {
    return "openai-responses";
  }
  return "openai-completions";
}

function compatForCustomProviderStyle(style: CustomProviderStyle): Model<Api>["compat"] | null {
  if (style === "openai-chat-completions") {
    return {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: false,
      supportsStrictMode: false,
      maxTokensField: "max_tokens",
    } as Model<"openai-completions">["compat"];
  }
  if (style === "openai-responses") {
    return {
      supportsDeveloperRole: false,
      supportsLongCacheRetention: false,
    } as Model<"openai-responses">["compat"];
  }
  if (style === "anthropic-messages") {
    return {
      supportsEagerToolInputStreaming: false,
      supportsLongCacheRetention: false,
      supportsCacheControlOnTools: false,
    } as Model<"anthropic-messages">["compat"];
  }
  return null;
}

function emptyAssistantMessage(model: Model<Api>): AssistantMessage {
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
  payload: Record<string, unknown>,
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
    ...(request.options?.timeoutMs !== undefined ? { timeoutMs: request.options.timeoutMs } : {}),
  };
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
  stream: RoutedAssistantMessageEventStream,
  model: Model<"openai-completions">,
  request: CustomProviderGenerationRequest,
): Promise<void> {
  type StreamingToolCall = ToolCall & {
    partialArgs?: string;
    streamIndex?: number;
  };
  type StreamingBlock = TextContent | ThinkingContent | StreamingToolCall;

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
  const ensureToolCallBlock = (delta: Record<string, unknown>, index: number): StreamingToolCall => {
    let block = toolCallBlocksByIndex.get(index);
    if (!block) {
      const fn = typeof delta.function === "object" && delta.function !== null
        ? delta.function as Record<string, unknown>
        : {};
      block = {
        type: "toolCall",
        id: typeof delta.id === "string" ? delta.id : "",
        name: typeof fn.name === "string" ? fn.name : "",
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
    if (!event || typeof event !== "object") continue;
    const chunk = event as Record<string, unknown>;
    if (typeof chunk.id === "string") {
      output.responseId ||= chunk.id;
    }
    if (typeof chunk.model === "string" && chunk.model.length > 0 && chunk.model !== model.id) {
      output.responseModel ||= chunk.model;
    }
    if (chunk.usage && typeof chunk.usage === "object") {
      output.usage = parseOpenAIUsage(chunk.usage as Record<string, unknown>, model);
    }
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const choice = choices[0] && typeof choices[0] === "object"
      ? choices[0] as Record<string, unknown>
      : null;
    if (!choice) continue;
    if (typeof choice.finish_reason === "string") {
      finishReason = choice.finish_reason;
    }
    const delta = choice.delta && typeof choice.delta === "object"
      ? choice.delta as Record<string, unknown>
      : {};
    const content = delta.content;
    if (typeof content === "string" && content.length > 0) {
      const block = ensureTextBlock();
      block.text += content;
      stream.push({ type: "text_delta", contentIndex: contentIndex(block), delta: content, partial: output });
    }
    for (const key of ["reasoning_content", "reasoning", "reasoning_text"]) {
      const value = delta[key];
      if (typeof value === "string" && value.length > 0) {
        const block = ensureThinkingBlock(key);
        block.thinking += value;
        stream.push({ type: "thinking_delta", contentIndex: contentIndex(block), delta: value, partial: output });
        break;
      }
    }
    const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    for (const toolCall of toolCalls) {
      if (!toolCall || typeof toolCall !== "object") continue;
      const record = toolCall as Record<string, unknown>;
      const index = typeof record.index === "number" ? record.index : toolCallBlocksByIndex.size;
      const block = ensureToolCallBlock(record, index);
      if (!block.id && typeof record.id === "string") {
        block.id = record.id;
      }
      const fn = typeof record.function === "object" && record.function !== null
        ? record.function as Record<string, unknown>
        : {};
      if (!block.name && typeof fn.name === "string") {
        block.name = fn.name;
      }
      const args = typeof fn.arguments === "string" ? fn.arguments : "";
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

async function* parseSseJson(response: Response): AsyncIterable<unknown> {
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

function* parseSseJsonText(body: string): Iterable<unknown> {
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

function parseSseJsonEvent(event: string): unknown | undefined {
  const data = event
    .split(/\r\n|\r|\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();
  if (!data || data === "[DONE]") {
    return undefined;
  }
  return JSON.parse(data);
}

function pushStreamError(
  stream: RoutedAssistantMessageEventStream,
  output: AssistantMessage,
  request: CustomProviderGenerationRequest,
  error: unknown,
): void {
  output.stopReason = request.options?.signal?.aborted ? "aborted" : "error";
  output.errorMessage = error instanceof Error ? error.message : String(error);
  stream.push({ type: "error", reason: output.stopReason, error: output });
  stream.end();
}

function convertChatTools(tools: Tool[]): unknown[] {
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
  rawUsage: Record<string, unknown>,
  model: Model<"openai-completions">,
): AssistantMessage["usage"] {
  const promptTokens = numericField(rawUsage.prompt_tokens);
  const completionTokens = numericField(rawUsage.completion_tokens);
  const promptDetails = rawUsage.prompt_tokens_details && typeof rawUsage.prompt_tokens_details === "object"
    ? rawUsage.prompt_tokens_details as Record<string, unknown>
    : {};
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

function numericField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
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

function resolvedOpenAICompletionsCompat(): Record<string, unknown> {
  return {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    supportsUsageInStreaming: true,
    maxTokensField: "max_tokens",
    requiresToolResultName: false,
    requiresAssistantAfterToolResult: false,
    requiresThinkingAsText: false,
    requiresReasoningContentOnAssistantMessages: false,
    thinkingFormat: "openai",
    openRouterRouting: {},
    vercelGatewayRouting: {},
    chatTemplateKwargs: {},
    zaiToolStream: false,
    supportsStrictMode: false,
    sendSessionAffinityHeaders: false,
    supportsLongCacheRetention: false,
  };
}

function resolveCustomProviderStyle(provider: string, providerStyle: unknown): CustomProviderStyle {
  const configured = normalizeCustomProviderStyle(providerStyle);
  if (configured) {
    return configured;
  }
  return provider === "anthropic" ? "anthropic-messages" : "openai-chat-completions";
}

function resolveCustomBaseUrl(
  provider: string,
  style: CustomProviderStyle,
  baseUrl: unknown,
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

function normalizeBaseUrl(value: unknown): string | null {
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

function normalizeProviderId(value: unknown): string {
  const normalized = normalizeOptionalText(value)?.toLowerCase();
  return normalized || CUSTOM_PROVIDER_ID;
}

function normalizeOptionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}
