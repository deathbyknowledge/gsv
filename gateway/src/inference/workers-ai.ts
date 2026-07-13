import { env } from "cloudflare:workers";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  ImageContent,
  Message,
  TextContent,
  ThinkingContent,
  ThinkingLevel,
  Tool,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import { calculateCost, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { DEFAULT_WORKERS_AI_MODEL } from "./default-models";
import { TimeoutError, isTimeoutError, withTimeout } from "./timeout";

export const WORKERS_AI_PROVIDER = "workers-ai";
export const WORKERS_AI_PROVIDER_ALIAS = "workersai";
export { DEFAULT_WORKERS_AI_MODEL };

const WORKERS_AI_API = "workers-ai-binding";
const PI_WORKERS_AI_PROVIDER = "cloudflare-workers-ai";

type WorkersAiMessage = {
  role: "user" | "assistant" | "system" | "tool";
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: WorkersAiToolCall[];
};

type WorkersAiTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters?: {
      type: "object";
      properties: Record<string, {
        type: string;
        description?: string;
      }>;
      required: string[];
    };
    strict: boolean | null;
  };
};

type WorkersAiRunInput = AiTextGenerationInput & {
  messages: WorkersAiMessage[];
  max_completion_tokens?: number;
  tools?: WorkersAiTool[];
  parallel_tool_calls?: boolean;
  reasoning_effort?: Exclude<ThinkingLevel, "off">;
  chat_template_kwargs?: {
    enable_thinking?: boolean;
    clear_thinking?: boolean;
    thinking?: boolean;
  };
};

type WorkersAiRunOutput = AiTextGenerationOutput & Record<string, unknown>;

type WorkersAiStreamInput = WorkersAiRunInput & {
  stream: true;
};

type WorkersAiToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

type DynamicWorkersAiBinding = {
  run(
    modelName: string,
    input: WorkersAiStreamInput,
    options?: WorkersAiRunOptions,
  ): Promise<ReadableStream>;
  run(
    modelName: string,
    input: WorkersAiRunInput,
    options?: WorkersAiRunOptions,
  ): Promise<WorkersAiRunOutput>;
};

type WorkersAiCatalogProperty = {
  property_id: string;
  value: string;
};

type WorkersAiCatalogModel = {
  id: string;
  name?: string;
  description?: string;
  properties?: WorkersAiCatalogProperty[];
};

type WorkersAiCatalogBinding = {
  models(params?: {
    author?: string;
    hide_experimental?: boolean;
    page?: number;
    per_page?: number;
    search?: string;
    source?: number;
    task?: string;
  }): Promise<WorkersAiCatalogModel[]>;
};

const workersAiContextWindowCache = new Map<string, Promise<number | null>>();

type WorkersAiRequest = {
  modelName: string;
  context: Context;
  reasoning?: ThinkingLevel;
  maxTokens: number;
  sessionAffinityKey?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

type WorkersAiRunOptions = AiOptions & {
  headers?: HeadersInit;
};

export function isWorkersAiProvider(provider: string): boolean {
  const normalized = provider.trim().toLowerCase();
  return normalized === WORKERS_AI_PROVIDER || normalized === WORKERS_AI_PROVIDER_ALIAS;
}

export function extractWorkersAiContextWindow(model: WorkersAiCatalogModel): number | null {
  for (const property of model.properties ?? []) {
    if (!isContextWindowPropertyId(property.property_id)) continue;
    const tokens = parseTokenQuantity(property.value);
    if (tokens !== null) {
      return tokens;
    }
  }

  return parseContextWindowDescription(model.description ?? "");
}

export async function resolveWorkersAiModelContextWindow(modelName: string): Promise<number | null> {
  const cacheKey = normalizeWorkersAiModelName(modelName);
  const cached = workersAiContextWindowCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const lookup = lookupWorkersAiModelContextWindow(modelName);
  workersAiContextWindowCache.set(cacheKey, lookup);
  return lookup;
}

export async function completeWithWorkersAi(
  request: WorkersAiRequest,
): Promise<AssistantMessage> {
  const ai = env.AI as unknown as DynamicWorkersAiBinding | undefined;
  if (!ai) {
    throw new Error("Workers AI binding is not configured for this worker");
  }

  const primaryInput = buildWorkersAiInput(request);
  const runOptions = buildWorkersAiRunOptions(request);

  try {
    const response = await runWorkersAiWithTimeout(
      ai,
      request.modelName,
      primaryInput,
      runOptions,
      request.timeoutMs,
      request.signal,
    );
    return normalizeWorkersAiResponse(response, request.modelName);
  } catch (error) {
    if (primaryInput.tools && primaryInput.tools.length > 0 && !shouldSkipNoToolsFallback(error, request.signal)) {
      const fallbackInput = buildWorkersAiInput(request, { disableTools: true });
      try {
        const fallbackResponse = await runWorkersAiWithTimeout(
          ai,
          request.modelName,
          fallbackInput,
          runOptions,
          request.timeoutMs,
          request.signal,
        );
        return normalizeWorkersAiResponse(fallbackResponse, request.modelName);
      } catch (fallbackError) {
        if (request.signal?.aborted) {
          throw fallbackError;
        }
      }
    }

    throw error;
  }
}

export function streamWithWorkersAi(
  request: WorkersAiRequest,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  void pumpWorkersAiStream(request, stream);
  return stream;
}

async function pumpWorkersAiStream(
  request: WorkersAiRequest,
  stream: AssistantMessageEventStream,
): Promise<void> {
  const ai = env.AI as unknown as DynamicWorkersAiBinding | undefined;
  if (!ai) {
    pushWorkersAiError(stream, request.modelName, "Workers AI binding is not configured for this worker");
    return;
  }

  const primaryInput = buildWorkersAiInput(request);
  const runOptions = buildWorkersAiRunOptions(request);
  const emitter = new WorkersAiPiEventEmitter(stream, request.modelName);

  try {
    await streamWorkersAiResponse(ai, request, primaryInput, runOptions, emitter);
    emitter.finish();
  } catch (error) {
    if (primaryInput.tools && primaryInput.tools.length > 0 && emitter.eventCount <= 1 && !shouldSkipNoToolsFallback(error, request.signal)) {
      try {
        const fallbackInput = buildWorkersAiInput(request, { disableTools: true });
        await streamWorkersAiResponse(ai, request, fallbackInput, runOptions, emitter);
        emitter.finish();
        return;
      } catch (fallbackError) {
        pushWorkersAiError(stream, request.modelName, fallbackError, request.signal?.aborted);
        return;
      }
    }

    pushWorkersAiError(stream, request.modelName, error, request.signal?.aborted);
  }
}

async function streamWorkersAiResponse(
  ai: DynamicWorkersAiBinding,
  request: WorkersAiRequest,
  input: WorkersAiRunInput,
  options: WorkersAiRunOptions | undefined,
  emitter: WorkersAiPiEventEmitter,
): Promise<void> {
  const timeoutMs = request.timeoutMs ?? 0;
  const abort = createWorkersAiAbort(request.signal, timeoutMs);

  try {
    const stream = await runWorkersAiStreamWithTimeout(
      ai,
      request.modelName,
      input,
      withWorkersAiAbortSignal(options, abort.signal),
      timeoutMs,
    );
    await readWorkersAiSse(stream, emitter, abort.signal);
  } finally {
    abort.clear();
  }
}

function shouldSkipNoToolsFallback(error: unknown, signal?: AbortSignal): boolean {
  return isTimeoutError(error)
    || signal?.aborted === true
    || (error instanceof Error && error.name === "AbortError");
}

async function runWorkersAiWithTimeout(
  ai: DynamicWorkersAiBinding,
  modelName: string,
  input: WorkersAiRunInput,
  options: WorkersAiRunOptions | undefined,
  timeoutMs: number | undefined,
  callerSignal?: AbortSignal,
): Promise<WorkersAiRunOutput> {
  const abort = createWorkersAiAbort(callerSignal, timeoutMs ?? 0);
  try {
    return await withTimeout(
      ai.run(modelName, input, withWorkersAiAbortSignal(options, abort.signal)),
      timeoutMs ?? 0,
      `Workers AI generation timed out after ${timeoutMs}ms`,
    );
  } finally {
    abort.clear();
  }
}

function runWorkersAiStreamWithTimeout(
  ai: DynamicWorkersAiBinding,
  modelName: string,
  input: WorkersAiRunInput,
  options: WorkersAiRunOptions | undefined,
  timeoutMs: number | undefined,
): Promise<ReadableStream> {
  const run = ai.run(modelName, { ...input, stream: true }, options);
  return withTimeout(
    run,
    timeoutMs ?? 0,
    `Workers AI generation timed out after ${timeoutMs}ms`,
  );
}

type WorkersAiSseEvent = {
  event?: string;
  data: string;
};

type WorkersAiToolAccumulator = {
  contentIndex: number;
  id: string;
  name: string;
  argumentsText: string;
};

type WorkersAiStreamDelta = {
  text?: string;
  thinking?: string;
  toolCalls?: Array<{
    index: number;
    id?: string;
    name?: string;
    argumentsDelta?: string;
  }>;
  usage?: AssistantMessage["usage"];
  finishReason?: string;
};

class WorkersAiPiEventEmitter {
  readonly stream: AssistantMessageEventStream;
  readonly partial: AssistantMessage;
  eventCount = 0;
  private readonly modelName: string;
  private textIndex: number | null = null;
  private thinkingIndex: number | null = null;
  private readonly toolCalls = new Map<number, WorkersAiToolAccumulator>();
  private finishReason: string | null = null;

  constructor(stream: AssistantMessageEventStream, modelName: string) {
    this.stream = stream;
    this.modelName = modelName;
    this.partial = {
      role: "assistant",
      content: [],
      api: WORKERS_AI_API,
      provider: WORKERS_AI_PROVIDER,
      model: modelName,
      usage: emptyUsage(),
      stopReason: "stop",
      timestamp: Date.now(),
    };
    this.push({
      type: "start",
      partial: snapshotAssistantMessage(this.partial),
    });
  }

  apply(delta: WorkersAiStreamDelta): void {
    if (delta.usage) {
      applyWorkersAiUsageCost(this.modelName, delta.usage);
      this.partial.usage = delta.usage;
    }
    if (delta.finishReason) {
      this.finishReason = delta.finishReason;
    }
    if (delta.thinking) {
      this.appendThinking(delta.thinking);
    }
    if (delta.text) {
      this.appendText(delta.text);
    }
    for (const toolCall of delta.toolCalls ?? []) {
      this.appendToolCall(toolCall);
    }
  }

  finish(): void {
    this.finishThinking();
    this.finishText();
    for (const index of Array.from(this.toolCalls.keys()).sort((a, b) => a - b)) {
      this.finishToolCall(index);
    }

    const message = snapshotAssistantMessage(this.partial);
    if (message.usage.totalTokens === 0) {
      message.usage.totalTokens = message.usage.input + message.usage.output;
    }
    applyWorkersAiUsageCost(this.modelName, message.usage);
    message.stopReason = this.resolveStopReason(message);

    if (!this.hasVisibleOutput(message)) {
      message.stopReason = "error";
      message.errorMessage = message.content.length === 0
        ? "Workers AI returned an empty response"
        : "Workers AI returned reasoning but no final response";
    }

    if (message.stopReason === "error" || message.stopReason === "aborted") {
      if (message.content.length === 0) {
        message.stopReason = "error";
        message.errorMessage = "Workers AI returned an empty response";
      }
      this.push({
        type: "error",
        reason: message.stopReason === "aborted" ? "aborted" : "error",
        error: message,
      });
      return;
    }

    this.push({
      type: "done",
      reason: message.stopReason === "length" ? "length" : message.stopReason === "toolUse" ? "toolUse" : "stop",
      message,
    });
  }

  private hasVisibleOutput(message: AssistantMessage): boolean {
    return message.content.some((block) => (
      block.type === "toolCall" ||
      (block.type === "text" && block.text.trim().length > 0)
    ));
  }

  private appendText(delta: string): void {
    if (this.textIndex === null) {
      this.textIndex = this.partial.content.length;
      this.partial.content.push({ type: "text", text: "" });
      this.push({
        type: "text_start",
        contentIndex: this.textIndex,
        partial: snapshotAssistantMessage(this.partial),
      });
    }

    const block = this.partial.content[this.textIndex];
    if (block?.type !== "text") return;
    block.text += delta;
    this.push({
      type: "text_delta",
      contentIndex: this.textIndex,
      delta,
      partial: snapshotAssistantMessage(this.partial),
    });
  }

  private finishText(): void {
    if (this.textIndex === null) return;
    const block = this.partial.content[this.textIndex];
    if (block?.type !== "text") return;
    this.push({
      type: "text_end",
      contentIndex: this.textIndex,
      content: block.text,
      partial: snapshotAssistantMessage(this.partial),
    });
    this.textIndex = null;
  }

  private appendThinking(delta: string): void {
    if (this.thinkingIndex === null) {
      this.thinkingIndex = this.partial.content.length;
      this.partial.content.push({ type: "thinking", thinking: "" });
      this.push({
        type: "thinking_start",
        contentIndex: this.thinkingIndex,
        partial: snapshotAssistantMessage(this.partial),
      });
    }

    const block = this.partial.content[this.thinkingIndex];
    if (block?.type !== "thinking") return;
    block.thinking += delta;
    this.push({
      type: "thinking_delta",
      contentIndex: this.thinkingIndex,
      delta,
      partial: snapshotAssistantMessage(this.partial),
    });
  }

  private finishThinking(): void {
    if (this.thinkingIndex === null) return;
    const block = this.partial.content[this.thinkingIndex];
    if (block?.type !== "thinking") return;
    this.push({
      type: "thinking_end",
      contentIndex: this.thinkingIndex,
      content: block.thinking,
      partial: snapshotAssistantMessage(this.partial),
    });
    this.thinkingIndex = null;
  }

  private appendToolCall(delta: NonNullable<WorkersAiStreamDelta["toolCalls"]>[number]): void {
    const existing = this.toolCalls.get(delta.index);
    if (!existing) {
      const accumulator: WorkersAiToolAccumulator = {
        contentIndex: this.partial.content.length,
        id: delta.id ?? `workers-ai-tool-${delta.index + 1}`,
        name: delta.name ?? "tool",
        argumentsText: "",
      };
      this.toolCalls.set(delta.index, accumulator);
      this.partial.content.push({
        type: "toolCall",
        id: accumulator.id,
        name: accumulator.name,
        arguments: {},
      });
      this.push({
        type: "toolcall_start",
        contentIndex: accumulator.contentIndex,
        partial: snapshotAssistantMessage(this.partial),
      });
    }

    const accumulator = this.toolCalls.get(delta.index);
    if (!accumulator) return;
    if (delta.id) accumulator.id = delta.id;
    if (delta.name) accumulator.name = delta.name;
    if (delta.argumentsDelta) accumulator.argumentsText += delta.argumentsDelta;

    const block = this.partial.content[accumulator.contentIndex];
    if (block?.type !== "toolCall") return;
    block.id = accumulator.id;
    block.name = accumulator.name;
    block.arguments = parseToolArguments(accumulator.argumentsText);

    if (delta.argumentsDelta) {
      this.push({
        type: "toolcall_delta",
        contentIndex: accumulator.contentIndex,
        delta: delta.argumentsDelta,
        partial: snapshotAssistantMessage(this.partial),
      });
    }
  }

  private finishToolCall(index: number): void {
    const accumulator = this.toolCalls.get(index);
    if (!accumulator) return;
    const block = this.partial.content[accumulator.contentIndex];
    if (block?.type !== "toolCall") return;
    block.id = accumulator.id;
    block.name = accumulator.name;
    block.arguments = parseToolArguments(accumulator.argumentsText);
    this.push({
      type: "toolcall_end",
      contentIndex: accumulator.contentIndex,
      toolCall: snapshotToolCall(block),
      partial: snapshotAssistantMessage(this.partial),
    });
  }

  private resolveStopReason(message: AssistantMessage): AssistantMessage["stopReason"] {
    if (message.content.some((block) => block.type === "toolCall")) {
      return "toolUse";
    }
    const reason = normalizeWorkersAiFinishReason(this.finishReason);
    if (reason) {
      return reason;
    }
    return "stop";
  }

  private push(event: AssistantMessageEvent): void {
    this.eventCount += 1;
    this.stream.push(snapshotAssistantMessageEvent(event));
  }
}

async function readWorkersAiSse(
  body: ReadableStream,
  emitter: WorkersAiPiEventEmitter,
  signal: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const abortRead = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", abortRead, { once: true });

  try {
    if (signal.aborted) {
      abortRead();
    }
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = drainSseEvents(buffer);
      buffer = events.remainder;
      for (const event of events.items) {
        applyWorkersAiSseEvent(event, emitter);
      }
    }

    if (signal.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("Workers AI stream aborted");
    }

    buffer += decoder.decode();
    const events = drainSseEvents(`${buffer}\n\n`);
    for (const event of events.items) {
      applyWorkersAiSseEvent(event, emitter);
    }
  } finally {
    signal.removeEventListener("abort", abortRead);
    reader.releaseLock();
  }
}

function drainSseEvents(input: string): { items: WorkersAiSseEvent[]; remainder: string } {
  const normalized = input.replace(/\r\n/g, "\n");
  const items: WorkersAiSseEvent[] = [];
  let cursor = 0;

  while (true) {
    const boundary = normalized.indexOf("\n\n", cursor);
    if (boundary === -1) {
      return {
        items,
        remainder: normalized.slice(cursor),
      };
    }

    const raw = normalized.slice(cursor, boundary);
    cursor = boundary + 2;
    const event = parseSseEvent(raw);
    if (event) {
      items.push(event);
    }
  }
}

function parseSseEvent(raw: string): WorkersAiSseEvent | null {
  let event: string | undefined;
  const data: string[] = [];

  for (const line of raw.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? "" : line.slice(separator + 1).replace(/^ /, "");
    if (field === "event") {
      event = value;
    } else if (field === "data") {
      data.push(value);
    }
  }

  if (data.length === 0) return null;
  return {
    event,
    data: data.join("\n"),
  };
}

function applyWorkersAiSseEvent(
  event: WorkersAiSseEvent,
  emitter: WorkersAiPiEventEmitter,
): void {
  const data = event.data.trim();
  if (!data || data === "[DONE]") {
    return;
  }

  const parsed = parseJsonObject(data);
  if (!parsed) {
    return;
  }

  const delta = extractWorkersAiStreamDelta(parsed);
  if (delta) {
    emitter.apply(delta);
  }
}

function extractWorkersAiStreamDelta(record: Record<string, unknown>): WorkersAiStreamDelta | null {
  const result: WorkersAiStreamDelta = {};

  const responseText = asString(record.response);
  if (responseText) {
    result.text = responseText;
  }

  const outputText = asString(record.output_text);
  if (outputText) {
    result.text = (result.text ?? "") + outputText;
  }

  const choices = Array.isArray(record.choices) ? record.choices : [];
  for (const choice of choices) {
    const choiceRecord = asRecord(choice);
    if (!choiceRecord) continue;
    const finishReason = asString(choiceRecord.finish_reason) ?? asString(choiceRecord.finishReason);
    if (finishReason) {
      result.finishReason = finishReason;
    }

    const delta = asRecord(choiceRecord.delta) ?? asRecord(choiceRecord.message);
    if (!delta) continue;
    const content = extractChoiceMessageText(delta);
    if (content) {
      result.text = (result.text ?? "") + content;
    }
    const thinking = extractChoiceMessageThinking(delta);
    if (thinking) {
      result.thinking = (result.thinking ?? "") + thinking;
    }
    const toolCalls = extractDeltaToolCalls(delta.tool_calls);
    if (toolCalls.length > 0) {
      result.toolCalls = [...(result.toolCalls ?? []), ...toolCalls];
    }
  }

  const usage = normalizeWorkersAiUsage(record.usage);
  if (usage) {
    result.usage = usage;
  }

  const finishReason = asString(record.finish_reason) ?? asString(record.finishReason);
  if (finishReason) {
    result.finishReason = finishReason;
  }

  const topLevelToolCalls = extractDeltaToolCalls(record.tool_calls);
  if (topLevelToolCalls.length > 0) {
    result.toolCalls = [...(result.toolCalls ?? []), ...topLevelToolCalls];
  }

  return result.text || result.thinking || result.toolCalls?.length || result.usage || result.finishReason
    ? result
    : null;
}

function extractDeltaToolCalls(input: unknown): NonNullable<WorkersAiStreamDelta["toolCalls"]> {
  if (!Array.isArray(input)) return [];

  return input.flatMap((entry, fallbackIndex) => {
    const record = asRecord(entry);
    if (!record) return [];
    const fn = asRecord(record.function);
    const index = typeof record.index === "number" && Number.isFinite(record.index)
      ? record.index
      : fallbackIndex;
    const id = asString(record.id);
    const name = asString(fn?.name) ?? asString(record.name);
    const argumentsDelta = asString(fn?.arguments) ?? asString(record.arguments);
    if (!id && !name && !argumentsDelta) return [];
    return [{
      index,
      id,
      name,
      argumentsDelta,
    }];
  });
}

function withWorkersAiAbortSignal(
  options: WorkersAiRunOptions | undefined,
  signal: AbortSignal,
): WorkersAiRunOptions {
  return {
    ...(options ?? {}),
    signal,
  };
}

function createWorkersAiAbort(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; clear: () => void } {
  const timeoutController = new AbortController();
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? setTimeout(() => {
        timeoutController.abort(new TimeoutError(`Workers AI generation timed out after ${timeoutMs}ms`));
      }, timeoutMs)
    : null;
  return {
    signal: callerSignal
      ? AbortSignal.any([callerSignal, timeoutController.signal])
      : timeoutController.signal,
    clear: () => {
      if (timeout !== null) clearTimeout(timeout);
    },
  };
}

function pushWorkersAiError(
  stream: AssistantMessageEventStream,
  modelName: string,
  error: unknown,
  callerAborted = false,
): void {
  const message = error instanceof Error ? error.message : String(error);
  const aborted = callerAborted || (error instanceof Error && error.name === "AbortError");
  const assistant: AssistantMessage = {
    role: "assistant",
    content: [],
    api: WORKERS_AI_API,
    provider: WORKERS_AI_PROVIDER,
    model: modelName,
    usage: emptyUsage(),
    stopReason: aborted ? "aborted" : "error",
    errorMessage: message,
    timestamp: Date.now(),
  };
  stream.push({
    type: "error",
    reason: aborted ? "aborted" : "error",
    error: assistant,
  });
}

function normalizeWorkersAiUsage(usage: unknown): AssistantMessage["usage"] | null {
  const record = asRecord(usage);
  if (!record) return null;
  const input = asNumber(record.prompt_tokens) || asNumber(record.input_tokens);
  const output = asNumber(record.completion_tokens) || asNumber(record.output_tokens);
  const totalTokens = asNumber(record.total_tokens) || asNumber(record.totalTokens) || input + output;
  const normalized = {
    input,
    output,
    cacheRead: asNumber(record.cached_tokens),
    cacheWrite: 0,
    totalTokens,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
  return normalized;
}

function normalizeWorkersAiFinishReason(reason: string | null): AssistantMessage["stopReason"] | null {
  if (!reason) return null;
  const normalized = reason.toLowerCase();
  if (normalized === "tool_calls" || normalized === "tool_use" || normalized === "function_call") {
    return "toolUse";
  }
  if (normalized === "length" || normalized === "max_tokens") {
    return "length";
  }
  if (normalized === "error") {
    return "error";
  }
  if (normalized === "aborted") {
    return "aborted";
  }
  return "stop";
}

function emptyUsage(): AssistantMessage["usage"] {
  return {
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
  };
}

function snapshotAssistantMessageEvent<T extends AssistantMessageEvent>(event: T): T {
  return JSON.parse(JSON.stringify(event)) as T;
}

function snapshotAssistantMessage(message: AssistantMessage): AssistantMessage {
  return JSON.parse(JSON.stringify(message)) as AssistantMessage;
}

function snapshotToolCall(toolCall: ToolCall): ToolCall {
  return JSON.parse(JSON.stringify(toolCall)) as ToolCall;
}

function parseJsonObject(input: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(input) as unknown;
    return asRecord(parsed);
  } catch {
    return null;
  }
}

async function lookupWorkersAiModelContextWindow(modelName: string): Promise<number | null> {
  const ai = env.AI as unknown as WorkersAiCatalogBinding | undefined;
  if (!ai || typeof ai.models !== "function") {
    return null;
  }

  try {
    for (const search of workersAiModelSearchTerms(modelName)) {
      const models = await ai.models({
        search,
        per_page: 50,
      });
      const exact = models.find((candidate) => isWorkersAiModelMatch(candidate, modelName));
      const contextWindow = exact ? extractWorkersAiContextWindow(exact) : null;
      if (contextWindow !== null) {
        return contextWindow;
      }
    }
  } catch {
    return null;
  }

  return null;
}

function workersAiModelSearchTerms(modelName: string): string[] {
  const lastSegment = modelName.split("/").filter(Boolean).at(-1);
  return Array.from(new Set([
    modelName,
    lastSegment ?? modelName,
  ].map((term) => term.trim()).filter((term) => term.length > 0)));
}

function isWorkersAiModelMatch(model: WorkersAiCatalogModel, modelName: string): boolean {
  const requested = normalizeWorkersAiModelName(modelName);
  return [
    model.id,
    model.name,
  ].some((candidate) => candidate !== undefined && normalizeWorkersAiModelName(candidate) === requested);
}

function normalizeWorkersAiModelName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^@cf\//, "");
}

function isContextWindowPropertyId(propertyId: string): boolean {
  const normalized = propertyId.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    normalized.includes("context") &&
    (normalized.includes("window") ||
      normalized.includes("token") ||
      normalized.includes("length"))
  ) || (
    normalized.includes("max") &&
    normalized.includes("input") &&
    normalized.includes("token")
  );
}

function parseContextWindowDescription(description: string): number | null {
  const normalized = description.replace(/,/g, "");
  const patterns = [
    /(\d+(?:\.\d+)?)\s*k\s*(?:token\s*)?context window/i,
    /(\d+(?:\.\d+)?)\s*(?:token|tokens)\s*context window/i,
    /context window[^.]{0,80}?(\d+(?:\.\d+)?)\s*k/i,
    /up to\s+(\d+(?:\.\d+)?)\s*k\s*tokens/i,
    /up to\s+(\d+(?:\.\d+)?)\s*(?:token|tokens)/i,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    const tokens = match ? parseTokenQuantity(match[0]) : null;
    if (tokens !== null) {
      return tokens;
    }
  }

  return null;
}

function parseTokenQuantity(value: string): number | null {
  const normalized = value.toLowerCase().replace(/,/g, "");
  const match = normalized.match(/(\d+(?:\.\d+)?)\s*([km])?\b/);
  if (!match) {
    return null;
  }

  const amount = Number.parseFloat(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }

  const multiplier = match[2] === "m"
    ? 1_000_000
    : match[2] === "k"
      ? 1_000
      : 1;
  const tokens = Math.round(amount * multiplier);
  return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : null;
}

export function buildWorkersAiInput(
  request: WorkersAiRequest,
  options?: { disableTools?: boolean },
): WorkersAiRunInput {
  const input: WorkersAiRunInput = {
    messages: contextToWorkersAiMessages(request.context) as unknown as WorkersAiRunInput["messages"],
    max_completion_tokens: request.maxTokens,
  };

  const tools = options?.disableTools ? [] : contextToWorkersAiTools(request.context);
  if (tools.length > 0) {
    input.tools = tools;
    input.parallel_tool_calls = true;
  }

  if (usesWorkersAiThinkingFlag(request.modelName)) {
    if (request.reasoning) {
      input.reasoning_effort = request.reasoning;
    }
    input.chat_template_kwargs = {
      thinking: Boolean(request.reasoning),
    };
  } else if (request.reasoning) {
    input.reasoning_effort = request.reasoning;
    input.chat_template_kwargs = {
      enable_thinking: true,
    };
  } else {
    input.chat_template_kwargs = {
      enable_thinking: false,
      clear_thinking: true,
    };
  }

  return input;
}

function usesWorkersAiThinkingFlag(modelName: string): boolean {
  return modelName.trim().toLowerCase() === "@cf/moonshotai/kimi-k2.6";
}

export function buildWorkersAiRunOptions(
  request: WorkersAiRequest,
): WorkersAiRunOptions | undefined {
  const sessionAffinityKey = request.sessionAffinityKey?.trim();
  if (!sessionAffinityKey) {
    return undefined;
  }

  return {
    headers: {
      "x-session-affinity": sessionAffinityKey,
    },
  };
}

export function contextToWorkersAiMessages(context: Context): WorkersAiMessage[] {
  const messages: WorkersAiMessage[] = [];

  const systemPrompt = context.systemPrompt?.trim();
  if (systemPrompt) {
    messages.push({
      role: "system",
      content: systemPrompt,
    });
  }

  for (const message of context.messages) {
    messages.push(...convertMessage(message));
  }

  return messages;
}

export function contextToWorkersAiTools(context: Context): WorkersAiTool[] {
  return (context.tools ?? []).map(convertTool);
}

export function normalizeWorkersAiResponse(
  response: WorkersAiRunOutput,
  modelName: string,
): AssistantMessage {
  const thinking = extractWorkersAiThinking(response);
  const text = extractWorkersAiText(response);
  const toolCalls = extractWorkersAiToolCalls(response);
  const content: Array<TextContent | ThinkingContent | ToolCall> = [];

  if (thinking) {
    content.push({
      type: "thinking",
      thinking,
    });
  }

  if (text) {
    content.push({
      type: "text",
      text,
    });
  }

  content.push(...toolCalls);

  const usage = {
    input: asNumber(response.usage?.prompt_tokens),
    output: asNumber(response.usage?.completion_tokens),
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: asNumber(response.usage?.total_tokens),
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };

  if (usage.totalTokens === 0) {
    usage.totalTokens = usage.input + usage.output;
  }

  applyWorkersAiUsageCost(modelName, usage);

  let stopReason: AssistantMessage["stopReason"] = "stop";
  let errorMessage: string | undefined;

  if (toolCalls.length > 0) {
    stopReason = "toolUse";
  } else if (!text) {
    stopReason = "error";
    errorMessage = thinking
      ? "Workers AI returned reasoning but no final response"
      : "Workers AI returned an empty response";
  }

  return {
    role: "assistant",
    content,
    api: WORKERS_AI_API,
    provider: WORKERS_AI_PROVIDER,
    model: modelName,
    usage,
    stopReason,
    errorMessage,
    timestamp: Date.now(),
  };
}

export function hasWorkersAiModelPricing(modelName: string): boolean {
  return resolveWorkersAiPricingModel(modelName) !== null;
}

function applyWorkersAiUsageCost(modelName: string, usage: AssistantMessage["usage"]): void {
  const model = resolveWorkersAiPricingModel(modelName);
  if (!model) {
    return;
  }
  calculateCost(model, usage);
}

function resolveWorkersAiPricingModel(modelName: string) {
  return getBuiltinModels(PI_WORKERS_AI_PROVIDER).find((model) => model.id === modelName) ?? null;
}

function convertMessage(message: Message): WorkersAiMessage[] {
  switch (message.role) {
    case "user":
      return [convertUserMessage(message)];
    case "assistant":
      return convertAssistantMessage(message);
    case "toolResult":
      return [convertToolResultMessage(message)];
  }
}

function convertUserMessage(message: UserMessage): WorkersAiMessage {
  return {
    role: "user",
    content: serializeUserContent(message.content),
  };
}

function convertAssistantMessage(message: Extract<Message, { role: "assistant" }>): WorkersAiMessage[] {
  const text = message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("");

  const toolCalls: WorkersAiToolCall[] = [];

  for (const block of message.content) {
    if (block.type !== "toolCall") continue;
    toolCalls.push({
      id: block.id,
      type: "function",
      function: {
        name: block.name,
        arguments: JSON.stringify(block.arguments ?? {}),
      },
    });
  }

  return [{
    role: "assistant",
    content: text || null,
    tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
  }];
}

function convertToolResultMessage(message: ToolResultMessage): WorkersAiMessage {
  return {
    role: "tool",
    content: serializeTextBlocks(message.content),
    tool_call_id: message.toolCallId,
  };
}

function convertTool(tool: Tool): WorkersAiTool {
  const schema = sanitizeToolParameters(tool.parameters as unknown as Record<string, unknown>);
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: schema,
      strict: false,
    },
  };
}

function serializeUserContent(
  content: UserMessage["content"],
): string {
  if (typeof content === "string") return content;
  return serializeTextBlocks(content);
}

function serializeTextBlocks(
  blocks: Array<TextContent | ImageContent>,
): string {
  const parts: string[] = [];
  let nextImageHasTextFallback = false;

  for (const block of blocks) {
    if (block.type === "text") {
      parts.push(block.text);
      nextImageHasTextFallback = hasStoredImageTextFallback(block.text);
      continue;
    }

    if (nextImageHasTextFallback) {
      nextImageHasTextFallback = false;
      continue;
    }

    parts.push("\n[Attached image omitted: no image description was available for this Workers AI text model.]");
  }

  return parts.join("");
}

function hasStoredImageTextFallback(text: string): boolean {
  return text.includes("\nImage description:");
}

function normalizeWorkersAiToolCalls(toolCalls: unknown): ToolCall[] {
  if (!Array.isArray(toolCalls)) return [];

  return toolCalls.flatMap((toolCall, index) => {
    if (!toolCall || typeof toolCall !== "object") return [];

    const openAiStyle = toolCall as {
      id?: unknown;
      function?: {
        name?: unknown;
        arguments?: unknown;
      };
      name?: unknown;
      arguments?: unknown;
    };

    const name = asString(openAiStyle.function?.name) ?? asString(openAiStyle.name);
    if (!name) return [];

    const id = asString(openAiStyle.id) ?? `workers-ai-tool-${index + 1}`;
    const argumentsInput = openAiStyle.function?.arguments ?? openAiStyle.arguments;

    return [{
      type: "toolCall",
      id,
      name,
      arguments: parseToolArguments(argumentsInput),
    }];
  });
}

function extractWorkersAiText(response: WorkersAiRunOutput): string {
  if (typeof response.response === "string" && response.response.length > 0) {
    return response.response;
  }

  if (typeof response.output_text === "string" && response.output_text.length > 0) {
    return response.output_text;
  }

  const choices = Array.isArray(response.choices) ? response.choices : [];
  const choiceText = choices
    .map((choice) => {
      if (!choice || typeof choice !== "object") return "";
      const message = (choice as { message?: unknown }).message;
      return extractChoiceMessageText(message);
    })
    .join("");
  if (choiceText) {
    return choiceText;
  }

  const output = Array.isArray(response.output) ? response.output : [];
  const outputText = output
    .flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const content = (item as { content?: unknown }).content;
      if (!Array.isArray(content)) return [];
      return content.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const type = (entry as { type?: unknown }).type;
        const text = (entry as { text?: unknown }).text;
        if (type === "output_text" && typeof text === "string") {
          return [text];
        }
        return [];
      });
    })
    .join("");

  return outputText;
}

function extractWorkersAiThinking(response: WorkersAiRunOutput): string {
  const choices = Array.isArray(response.choices) ? response.choices : [];
  const choiceReasoning = choices
    .map((choice) => {
      if (!choice || typeof choice !== "object") return "";
      const message = (choice as { message?: unknown }).message;
      return extractChoiceMessageThinking(message);
    })
    .join("");
  if (choiceReasoning) {
    return choiceReasoning;
  }

  const output = Array.isArray(response.output) ? response.output : [];
  const outputReasoning = output
    .flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const type = (item as { type?: unknown }).type;
      if (type !== "reasoning") return [];

      const content = (item as { content?: unknown }).content;
      if (Array.isArray(content)) {
        const contentReasoning = content.flatMap((entry) => {
          if (!entry || typeof entry !== "object") return [];
          const entryType = (entry as { type?: unknown }).type;
          const text = (entry as { text?: unknown }).text;
          if (entryType === "reasoning_text" && typeof text === "string") {
            return [text];
          }
          return [];
        }).join("");
        if (contentReasoning) {
          return [contentReasoning];
        }
      }

      const summary = (item as { summary?: unknown }).summary;
      if (Array.isArray(summary)) {
        const summaryReasoning = summary.flatMap((entry) => {
          if (!entry || typeof entry !== "object") return [];
          const entryType = (entry as { type?: unknown }).type;
          const text = (entry as { text?: unknown }).text;
          if (entryType === "summary_text" && typeof text === "string") {
            return [text];
          }
          return [];
        }).join("");
        if (summaryReasoning) {
          return [summaryReasoning];
        }
      }

      return [];
    })
    .join("\n");

  return outputReasoning;
}

function extractWorkersAiToolCalls(response: WorkersAiRunOutput): ToolCall[] {
  const fromTopLevel = normalizeWorkersAiToolCalls(response.tool_calls);
  if (fromTopLevel.length > 0) {
    return fromTopLevel;
  }

  const choices = Array.isArray(response.choices) ? response.choices : [];
  const fromChoices = choices.flatMap((choice) => {
    if (!choice || typeof choice !== "object") return [];
    const message = (choice as { message?: unknown }).message;
    if (!message || typeof message !== "object") return [];
    return normalizeWorkersAiToolCalls((message as { tool_calls?: unknown }).tool_calls);
  });
  if (fromChoices.length > 0) {
    return fromChoices;
  }

  const output = Array.isArray(response.output) ? response.output : [];
  const fromOutput = output.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const type = (item as { type?: unknown }).type;
    if (type !== "function_call") return [];
    const id = asString((item as { call_id?: unknown }).call_id)
      ?? asString((item as { id?: unknown }).id)
      ?? "workers-ai-tool-1";
    const name = asString((item as { name?: unknown }).name);
    const argumentsInput = (item as { arguments?: unknown }).arguments;
    if (!name) return [];
    return [{
      type: "toolCall" as const,
      id,
      name,
      arguments: parseToolArguments(argumentsInput),
    }];
  });

  return fromOutput;
}

function extractChoiceMessageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";

  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const type = (entry as { type?: unknown }).type;
      const text = (entry as { text?: unknown }).text;
      if (type === "text" && typeof text === "string") {
        return [text];
      }
      return [];
    }).join("");
  }

  return "";
}

function extractChoiceMessageThinking(message: unknown): string {
  if (!message || typeof message !== "object") return "";

  const reasoningContent = (message as { reasoning_content?: unknown }).reasoning_content;
  if (typeof reasoningContent === "string") {
    return reasoningContent;
  }

  const reasoning = (message as { reasoning?: unknown }).reasoning;
  if (typeof reasoning === "string") {
    return reasoning;
  }
  if (Array.isArray(reasoning)) {
    return reasoning.flatMap((entry) => {
      if (typeof entry === "string") return [entry];
      if (!entry || typeof entry !== "object") return [];
      const text = (entry as { text?: unknown }).text;
      return typeof text === "string" ? [text] : [];
    }).join("");
  }
  if (reasoning && typeof reasoning === "object") {
    const summary = (reasoning as { summary?: unknown }).summary;
    if (typeof summary === "string") {
      return summary;
    }
    if (Array.isArray(summary)) {
      return summary.flatMap((entry) => {
        if (typeof entry === "string") return [entry];
        if (!entry || typeof entry !== "object") return [];
        const text = (entry as { text?: unknown }).text;
        return typeof text === "string" ? [text] : [];
      }).join("");
    }
  }

  return "";
}

function sanitizeToolParameters(
  schema: Record<string, unknown> | undefined,
): WorkersAiTool["function"]["parameters"] | undefined {
  if (!schema || schema.type !== "object") return undefined;

  const propertiesInput = schema.properties;
  const requiredInput = schema.required;
  const properties: NonNullable<WorkersAiTool["function"]["parameters"]>["properties"] = {};

  if (propertiesInput && typeof propertiesInput === "object" && !Array.isArray(propertiesInput)) {
    for (const [key, value] of Object.entries(propertiesInput)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const property = value as { type?: unknown; description?: unknown };
      if (typeof property.type !== "string") continue;
      properties[key] = {
        type: property.type,
        description: typeof property.description === "string" ? property.description : undefined,
      };
    }
  }

  return {
    type: "object",
    properties,
    required: Array.isArray(requiredInput)
      ? requiredInput.filter((value): value is string => typeof value === "string")
      : [],
  };
}

function parseToolArguments(input: unknown): Record<string, unknown> {
  if (!input) return {};
  if (typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  if (typeof input !== "string") {
    return { value: input };
  }

  try {
    const parsed = JSON.parse(input) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { value: input };
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
