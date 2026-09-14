import {
  createProvider,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import {
  CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL,
  type AiBinding,
} from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import {
  GSV_INFERENCE_PRODUCT_MODEL,
  GSV_INFERENCE_PROVIDER,
} from "@humansandmachines/gsv/protocol";
import {
  classifyProviderFailure,
  type InferenceFailure,
  type ProviderFailureInput,
} from "./failure";
import type { InferenceModelRouting, InferenceRequest, InferencePartial, InferenceResult, InferenceRouting, InferenceStreamEvent, InferenceAbortReason } from "./types";
import { createAttributedAiBindingFetch } from "./ai-gateway-fetch";

const GSV_INFERENCE_API = "gsv-inference";
const AI_GATEWAY_ID = "default";
const AI_GATEWAY_BASE_URL =
  `https://workers-binding.ai/ai-gateway/gateways/${AI_GATEWAY_ID}`;
const AI_GATEWAY_COMPAT_URL = `${AI_GATEWAY_BASE_URL}/compat`;
const WORKERS_AI_MODEL_PREFIX = "workers-ai/";

export type WorkersAiGeneration = {
  stream: (routing: InferenceRouting) => AsyncIterable<AssistantMessageEvent>;
  result: (routing: InferenceRouting) => Promise<InferenceResult>;
  attempts: () => readonly WorkersAiAttempt[];
  accepted: () => boolean;
  failure: (message?: string) => InferenceFailure;
  abort: (reason?: InferenceAbortReason) => Promise<void>;
  terminalResult: () => InferenceResult | undefined;
  waitFor: <T>(operation: Promise<T>) => Promise<T | undefined>;
};

type GenerationEnd = "completed" | "aborted" | "timed_out";

export type WorkersAiAttempt = {
  model: InferenceModelRouting;
  result?: InferenceResult;
  failure?: InferenceFailure;
  accepted: boolean;
  startedAt: number;
  completedAt?: number;
  providerStatusCode?: number;
  transportFailed: boolean;
  timeoutKind?: "first_output" | "generation";
  firstActivityAt?: number;
  lastActivityAt?: number;
  outputExposed: boolean;
};

const workersAi = createProvider<"openai-completions">({
  id: "cloudflare-ai-gateway",
  name: "Cloudflare AI Gateway",
  baseUrl: AI_GATEWAY_COMPAT_URL,
  auth: {
    apiKey: {
      name: "Workers AI binding",
      resolve: async () => ({ auth: {}, source: "Workers AI binding" }),
    },
  },
  models: [],
  api: openAICompletionsApi(),
});

export function createWorkersAiGeneration(
  input: InferenceRequest,
  binding: AiBinding,
): WorkersAiGeneration {
  if (input.model !== GSV_INFERENCE_PRODUCT_MODEL) {
    throw new Error(`Unsupported managed inference model: ${input.model}`);
  }
  const abortController = new AbortController();
  const deadlineAt = Math.min(
    Date.now() + input.timeoutMs,
    input.deadlineAt ?? Infinity,
  );
  const rawBindingFetch = createAttributedAiBindingFetch(binding, input);
  const attempts: WorkersAiAttempt[] = [];
  let activeAttempt: WorkersAiAttempt | undefined;
  let eventStream: AsyncIterable<AssistantMessageEvent> | undefined;
  let resultPromise: Promise<InferenceResult> | undefined;
  let end: GenerationEnd | undefined;
  let resolveEnd: (end: GenerationEnd) => void = () => {};
  const ended = new Promise<GenerationEnd>((resolve) => {
    resolveEnd = resolve;
  });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const finish = (next: GenerationEnd) => {
    if (end) return;
    end = next;
    if (deadline !== undefined) clearTimeout(deadline);
    resolveEnd(next);
    if (next !== "completed") {
      abortController.abort(new DOMException(
        next === "timed_out"
          ? "Managed inference timed out"
          : "Managed inference was cancelled",
        "AbortError",
      ));
    }
  };
  const getEnd = () => {
    if (!end && Date.now() >= deadlineAt) finish("timed_out");
    return end;
  };
  const startDeadline = () => {
    if (!getEnd()) {
      deadline ??= setTimeout(
        () => finish("timed_out"),
        deadlineAt - Date.now(),
      );
    }
  };
  const stream = (routing: InferenceRouting) => {
    eventStream ??= streamWorkersAiGeneration(
      input,
      routing,
      abortController.signal,
      rawBindingFetch,
      ended,
      finish,
      attempts,
      (attempt) => {
        activeAttempt = attempt;
      },
      getEnd,
      deadlineAt,
    );
    startDeadline();
    return eventStream;
  };
  return {
    stream,
    result: (routing) => {
      resultPromise ??= resultFromEvents(stream(routing));
      return resultPromise;
    },
    attempts: () => attempts.slice(),
    accepted: () => activeAttempt?.accepted === true
      || attempts.some((attempt) => attempt.accepted),
    failure: (message) => attempts.at(-1)?.failure
      ?? classifyAttemptFailure(activeAttempt, end, message),
    abort: async (reason = "cancelled") => {
      getEnd();
      finish(reason === "timeout" ? "timed_out" : "aborted");
    },
    terminalResult: () => {
      const terminal = getEnd();
      return terminal && terminal !== "completed"
        ? toInferenceResult(generationEndEvent(terminal, input).error)
        : undefined;
    },
    waitFor: async <T>(operation: Promise<T>) => {
      startDeadline();
      const outcome = await Promise.race([
        operation.then((value) => ({ value })),
        ended.then(() => undefined),
      ]);
      if (!outcome) {
        // SAFETY: Workers RPC promises have a disposer; local promises may omit it.
        const disposable = operation as Promise<T> & { [Symbol.dispose]?(): void };
        disposable[Symbol.dispose]?.();
      }
      return outcome?.value;
    },
  };
}

async function* streamWorkersAiGeneration(
  input: InferenceRequest,
  routing: InferenceRouting,
  signal: AbortSignal,
  rawBindingFetch: typeof fetch,
  ended: Promise<GenerationEnd>,
  finish: (end: GenerationEnd) => void,
  attempts: WorkersAiAttempt[],
  setActiveAttempt: (attempt: WorkersAiAttempt) => void,
  getEnd: () => GenerationEnd | undefined,
  deadlineAt: number,
): AsyncGenerator<AssistantMessageEvent> {
  const context: Context = {
    systemPrompt: input.systemPrompt,
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
    messages: input.messages as Context["messages"],
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
    tools: input.tools as Context["tools"],
  };
  for (const [index, modelRouting] of routing.models.entries()) {
    const terminal = getEnd();
    if (terminal && terminal !== "completed") {
      yield generationEndEvent(terminal, input);
      return;
    }
    const attempt: WorkersAiAttempt = {
      model: modelRouting,
      accepted: false,
      transportFailed: false,
      startedAt: Date.now(),
      outputExposed: false,
    };
    attempts.push(attempt);
    setActiveAttempt(attempt);
    const attemptAbort = new AbortController();
    const attemptSignal = AbortSignal.any([signal, attemptAbort.signal]);
    const bindingFetch = bindingFetchForAttempt(rawBindingFetch, attempt, attemptSignal);
    let firstOutputTimer: ReturnType<typeof setTimeout> | undefined;
    const firstOutputTimeout = new Promise<void>((resolve) => {
      const remainingModels = routing.models.length - index;
      if (remainingModels <= 1) return;
      firstOutputTimer = setTimeout(() => {
        attempt.timeoutKind = "first_output";
        resolve();
        attemptAbort.abort(new DOMException(
          "Managed inference attempt timed out before output",
          "TimeoutError",
        ));
      }, Math.max(1, Math.floor((deadlineAt - Date.now()) / remainingModels)));
    });
    const source = workersAi.streamSimple(
      workersAiModel(modelRouting),
      context,
      {
        fetch: bindingFetch,
        signal: attemptSignal,
        maxTokens: Math.min(
          input.maxOutputTokens,
          modelRouting.maxOutputTokens,
        ),
        reasoning: input.reasoning,
        timeoutMs: Math.max(1, deadlineAt - Date.now()),
        maxRetries: 0,
        sessionId: input.actor.processId ?? input.logicalRequestId,
        headers: {
          "cf-aig-authorization":
            `Bearer ${CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL}`,
          "cf-aig-collect-log-payload": "false",
          Authorization: null,
          "x-api-key": null,
        },
      },
    );
    const iterator = source[Symbol.asyncIterator]();
    let start: Extract<AssistantMessageEvent, { type: "start" }> | undefined;
    const pending: AssistantMessageEvent[] = [];
    try {
      while (true) {
        const event = await nextAttemptEvent(
          iterator, ended, input, signal, firstOutputTimeout, attempt, getEnd,
        );
        if (event.type === "start") {
          start = structuredClone(event);
          continue;
        }
        if (event.type === "done" || event.type === "error") {
          const result = toInferenceResult(
            event.type === "done" ? event.message : event.error,
          );
          const failure = event.type === "error" && event.reason === "error"
            ? classifyAttemptFailure(attempt, getEnd(), result.errorMessage)
            : undefined;
          attempt.result = result;
          attempt.failure = failure;
          attempt.completedAt = Date.now();
          const canFallback = event.type === "error"
            && event.reason === "error"
            && !attempt.outputExposed
            && !signal.aborted
            && failure?.retryable === true
            && index + 1 < routing.models.length;
          if (canFallback) break;
          finish("completed");
          if (start) yield start;
          if (event.type === "done") {
            for (const buffered of pending) yield buffered;
          }
          yield event;
          return;
        }
        if (!attempt.outputExposed && !exposesContent(event)) {
          pending.push(structuredClone(event));
          continue;
        }
        if (firstOutputTimer !== undefined) clearTimeout(firstOutputTimer);
        attempt.outputExposed = true;
        if (start) {
          yield start;
          start = undefined;
        }
        for (const buffered of pending.splice(0)) {
          if (getEnd()) break;
          yield buffered;
        }
        if (getEnd()) continue;
        yield event;
      }
    } finally {
      if (firstOutputTimer !== undefined) clearTimeout(firstOutputTimer);
      attemptAbort.abort();
      const close = iterator.return?.();
      if (close) void close.catch(() => {});
    }
  }
}

function exposesContent(event: AssistantMessageEvent): boolean {
  switch (event.type) {
    case "text_delta":
    case "thinking_delta":
      return event.delta.length > 0;
    case "text_end":
    case "thinking_end":
      return event.content.length > 0;
    case "toolcall_start":
    case "toolcall_delta":
    case "toolcall_end": {
      if (event.type === "toolcall_delta" && event.delta.length > 0) return true;
      const tool = event.type === "toolcall_end"
        ? event.toolCall
        : event.partial.content[event.contentIndex];
      return tool?.type === "toolCall" && (
        tool.id.length > 0 || tool.name.length > 0 || Object.keys(tool.arguments).length > 0
      );
    }
    default:
      return false;
  }
}

function bindingFetchForAttempt(
  rawBindingFetch: typeof fetch,
  attempt: WorkersAiAttempt,
  signal: AbortSignal,
): typeof fetch {
  return async (request, init) => {
    try {
      const response = await rawBindingFetch(request, init);
      attempt.providerStatusCode = response.status;
      if (response.ok) attempt.accepted = true;
      if (signal.aborted) {
        void response.body?.cancel(signal.reason).catch(() => {});
        throw signal.reason;
      }
      if (!response.body) return response;
      const body = observeAttemptBody(response.body, attempt, signal);
      return new Response(body, response);
    } catch (error) {
      attempt.transportFailed = true;
      throw error;
    }
  };
}

function observeAttemptBody(
  body: ReadableStream<Uint8Array>,
  attempt: WorkersAiAttempt,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let finished = false;
  let onAbort: () => void;
  const cancel: NonNullable<UnderlyingSource<Uint8Array>["cancel"]> = (reason) => {
    if (finished) return;
    finished = true;
    signal.removeEventListener("abort", onAbort);
    void reader.cancel(reason).catch(() => {});
    reader.releaseLock();
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      onAbort = () => {
        if (finished) return;
        controller.error(signal.reason);
        cancel(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    },
    async pull(controller) {
      try {
        const next = await reader.read();
        if (finished) return;
        if (next.done) {
          finished = true;
          signal.removeEventListener("abort", onAbort);
          reader.releaseLock();
          controller.close();
        } else {
          if (next.value.byteLength > 0) {
            attempt.firstActivityAt ??= Date.now();
            attempt.lastActivityAt = Date.now();
          }
          controller.enqueue(next.value);
        }
      } catch (error) {
        if (finished) return;
        finished = true;
        signal.removeEventListener("abort", onAbort);
        reader.releaseLock();
        controller.error(error);
      }
    },
    cancel,
  });
}

async function nextAttemptEvent(
  iterator: AsyncIterator<AssistantMessageEvent>,
  ended: Promise<GenerationEnd>,
  input: InferenceRequest,
  signal: AbortSignal,
  firstOutputTimeout: Promise<void>,
  attempt: WorkersAiAttempt,
  getEnd: () => GenerationEnd | undefined,
): Promise<AssistantMessageEvent> {
  const outcome = await Promise.race([
    iterator.next().then(
      (next) => ({ kind: "event", next }) as const,
      (error) => ({ kind: "failure", error: error instanceof Error ? error : new Error(String(error)) }) as const,
    ),
    ended.then((reason) => ({ kind: "ended", reason }) as const),
    firstOutputTimeout.then(() => ({ kind: "first_output_timeout" }) as const),
  ]);
  const terminal = getEnd();
  if (terminal || outcome.kind === "ended") {
    const reason = terminal ?? (outcome.kind === "ended" ? outcome.reason : undefined);
    if (!reason || reason === "completed") {
      throw new Error("Managed inference generation already completed");
    }
    if (reason === "timed_out") attempt.timeoutKind = "generation";
    return generationEndEvent(reason, input);
  }
  if (attempt.timeoutKind === "first_output" || outcome.kind === "first_output_timeout") {
    return inferenceErrorEvent(false, new Error(
      "Managed inference attempt timed out before output",
    ));
  }
  if (outcome.kind === "failure") {
    return inferenceErrorEvent(
      signal.aborted,
      outcome.error,
    );
  }
  if (outcome.next.done) {
    return inferenceErrorEvent(
      false,
      new Error("Workers AI generation ended without a terminal event"),
    );
  }
  return outcome.next.value;
}

function classifyAttemptFailure(
  attempt: WorkersAiAttempt | undefined,
  end: GenerationEnd | undefined,
  message?: string,
): InferenceFailure {
  const input: ProviderFailureInput = {
    stage: attempt?.accepted ? "stream" : "provider",
    timedOut: end === "timed_out" || attempt?.timeoutKind !== undefined,
    transportFailed: attempt?.transportFailed === true,
  };
  if (attempt?.providerStatusCode !== undefined) input.statusCode = attempt.providerStatusCode;
  if (message !== undefined) input.message = message;
  return classifyProviderFailure(input);
}

function generationEndEvent(
  reason: Exclude<GenerationEnd, "completed">,
  input: InferenceRequest,
): Extract<AssistantMessageEvent, { type: "error" }> {
  return inferenceErrorEvent(
    reason === "aborted",
    reason === "timed_out"
      ? new Error(`Managed inference exceeded its ${input.timeoutMs} ms deadline`)
      : undefined,
  );
}

async function resultFromEvents(
  events: AsyncIterable<AssistantMessageEvent>,
): Promise<InferenceResult> {
  for await (const event of events) {
    if (event.type === "done") return toInferenceResult(event.message);
    if (event.type === "error") return toInferenceResult(event.error);
  }
  throw new Error("Workers AI generation ended without a result");
}

function workersAiModel(
  routing: InferenceModelRouting,
): Model<"openai-completions"> {
  return {
    id: `${WORKERS_AI_MODEL_PREFIX}${routing.modelId}`,
    name: routing.displayName,
    api: "openai-completions",
    provider: "cloudflare-ai-gateway",
    baseUrl: AI_GATEWAY_COMPAT_URL,
    reasoning: routing.reasoning,
    input: ["text", "image"],
    cost: {
      input: routing.inputNanoUsdPerToken / 1_000,
      output: routing.outputNanoUsdPerToken / 1_000,
      cacheRead: routing.cacheReadNanoUsdPerToken / 1_000,
      cacheWrite: routing.cacheWriteNanoUsdPerToken / 1_000,
    },
    contextWindow: routing.contextWindow,
    maxTokens: routing.maxOutputTokens,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: "max_tokens",
      supportsStrictMode: false,
      supportsLongCacheRetention: false,
      sendSessionAffinityHeaders: true,
    },
  };
}

function toInferenceResult(
  message: AssistantMessage,
): InferenceResult {
  const partial = toInferenceMessage(message);
  if (partial.stopReason === "pending") {
    throw new Error("Workers AI generation ended without a terminal result");
  }
  return {
    ...partial,
    stopReason: partial.stopReason,
  };
}

function toInferenceMessage(
  message: AssistantMessage,
): InferencePartial {
  return {
    role: "assistant",
    content: cloneAssistantContent(message.content),
    api: GSV_INFERENCE_API,
    provider: GSV_INFERENCE_PROVIDER,
    model: GSV_INFERENCE_PRODUCT_MODEL,
    responseModel: underlyingModelId(message.responseModel ?? message.model),
    responseId: message.responseId,
    usage: toManagedUsage(message.usage),
    stopReason: inferenceStopReason(message.stopReason),
    errorMessage: message.errorMessage,
    timestamp: message.timestamp ?? Date.now(),
  };
}

function underlyingModelId(modelId: string): string {
  return modelId.startsWith(WORKERS_AI_MODEL_PREFIX)
    ? modelId.slice(WORKERS_AI_MODEL_PREFIX.length)
    : modelId;
}

function toManagedUsage(
  usage: AssistantMessage["usage"],
): InferenceResult["usage"] {
  const usageResult: InferenceResult["usage"] = {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.totalTokens,
    cost: {
      input: usage.cost.input,
      output: usage.cost.output,
      cacheRead: usage.cost.cacheRead,
      cacheWrite: usage.cost.cacheWrite,
      total: usage.cost.total,
    },
  };
  if (usage.cacheWrite1h !== undefined) {
    usageResult.cacheWrite1h = usage.cacheWrite1h;
  }
  return usageResult;
}

export function toInferenceStreamEvent(
  event: AssistantMessageEvent,
): InferenceStreamEvent {
  switch (event.type) {
    case "start":
      return {
        type: "start",
        partial: toInferenceMessage(event.partial),
      };
    case "text_start":
    case "text_end":
      return {
        type: event.type,
        contentIndex: event.contentIndex,
        content: requireContentBlock(event, "text"),
      };
    case "text_delta":
    case "thinking_delta":
      return {
        type: event.type,
        contentIndex: event.contentIndex,
        delta: event.delta,
      };
    case "thinking_start":
    case "thinking_end":
      return {
        type: event.type,
        contentIndex: event.contentIndex,
        content: requireContentBlock(event, "thinking"),
      };
    case "toolcall_start":
      return {
        type: "toolcall_start",
        contentIndex: event.contentIndex,
        toolCall: requireContentBlock(event, "toolCall"),
      };
    case "toolcall_delta":
      return {
        type: "toolcall_delta",
        contentIndex: event.contentIndex,
        delta: event.delta,
        toolCall: requireContentBlock(event, "toolCall"),
      };
    case "toolcall_end":
      return {
        type: "toolcall_end",
        contentIndex: event.contentIndex,
        toolCall: cloneToolCall(event.toolCall),
      };
    case "done":
      if (event.reason === "deferred") {
        throw new Error("Managed inference does not support deferred responses");
      }
      return {
        type: "done",
        reason: event.reason,
        message: toInferenceResult(event.message),
      };
    case "error":
      return {
        type: "error",
        reason: event.reason,
        error: toInferenceResult(event.error),
      };
  }
}

function inferenceStopReason(
  stopReason: AssistantMessage["stopReason"],
): InferencePartial["stopReason"] {
  if (stopReason === "deferred") {
    throw new Error("Managed inference does not support deferred responses");
  }
  return stopReason;
}

function requireContentBlock<T extends "text" | "thinking" | "toolCall">(
  event: Extract<AssistantMessageEvent, { contentIndex: number }>,
  type: T,
): Extract<InferenceResult["content"][number], { type: T }> {
  if (!("partial" in event)) {
    throw new Error("Managed inference event has no partial message");
  }
  const block = event.partial.content[event.contentIndex];
  if (!block || block.type !== type) {
    throw new Error(`Managed inference ${type} event has invalid content`);
  }
  if (block.type === "toolCall") {
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
    return cloneToolCall(block) as Extract<
      InferenceResult["content"][number],
      { type: T }
    >;
  }
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
  return { ...block } as Extract<
    InferenceResult["content"][number],
    { type: T }
  >;
}

function cloneAssistantContent(
  content: AssistantMessage["content"],
): InferenceResult["content"] {
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
  return content.map((block) => block.type === "toolCall"
    ? cloneToolCall(block)
    : { ...block }) as InferenceResult["content"];
}

function cloneToolCall(
  toolCall: Extract<AssistantMessage["content"][number], { type: "toolCall" }>,
): Extract<InferenceResult["content"][number], { type: "toolCall" }> {
  // Project onto the strict managed wire contract. Streaming providers attach
  // scratch fields such as partialArgs and streamIndex to partial tool calls.
  const clone: Extract<
    InferenceResult["content"][number],
    { type: "toolCall" }
  > = {
    type: "toolCall",
    id: toolCall.id,
    name: toolCall.name,
    arguments: structuredClone(toolCall.arguments),
  };
  if (toolCall.thoughtSignature !== undefined) {
    clone.thoughtSignature = toolCall.thoughtSignature;
  }
  return clone;
}

function inferenceErrorEvent(
  aborted: boolean,
  error: Error | Record<string, string | number | boolean | null | undefined> | string | null | undefined,
): Extract<AssistantMessageEvent, { type: "error" }> {
  const message: InferenceResult = {
    role: "assistant",
    content: [],
    api: GSV_INFERENCE_API,
    provider: GSV_INFERENCE_PROVIDER,
    model: GSV_INFERENCE_PRODUCT_MODEL,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: aborted ? "aborted" : "error",
    errorMessage: aborted
      ? "Managed inference was cancelled"
      : error instanceof Error
        ? error.message
        : "Managed inference failed",
    timestamp: Date.now(),
  };
  return {
    type: "error",
    reason: aborted ? "aborted" : "error",
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
    error: message as AssistantMessage,
  };
}
