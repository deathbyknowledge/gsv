import {
  createAssistantMessageEventStream,
  createProvider,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type OpenRouterRouting,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import {
  GSV_INFERENCE_PRODUCT_MODEL,
  GSV_INFERENCE_PROVIDER,
  type ManagedInferenceRequest,
  type ManagedInferencePartial,
  type ManagedInferenceResult,
  type ManagedInferenceRouting,
  type ManagedInferenceStreamEvent,
} from "@humansandmachines/gsv/protocol";

const GSV_INFERENCE_API = "gsv-inference";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
type OpenRouterGeneration = {
  stream: (routing: ManagedInferenceRouting) => AssistantMessageEventStream;
  result: (routing: ManagedInferenceRouting) => Promise<ManagedInferenceResult>;
  accepted: () => boolean;
  abort: () => Promise<void>;
};

const openRouter = createProvider<"openai-completions">({
  id: "openrouter",
  name: "OpenRouter",
  baseUrl: OPENROUTER_BASE_URL,
  auth: {
    apiKey: {
      name: "OpenRouter API key",
      resolve: async () => ({ auth: {}, source: "inference service secret" }),
    },
  },
  models: [],
  api: openAICompletionsApi(),
});

export function createOpenRouterGeneration(
  input: ManagedInferenceRequest,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): OpenRouterGeneration {
  if (input.model !== GSV_INFERENCE_PRODUCT_MODEL) {
    throw new Error(`Unsupported managed inference model: ${input.model}`);
  }
  if (!apiKey.trim()) {
    throw new Error("Managed inference credential is not configured");
  }

  const abortController = new AbortController();
  let accepted = false;
  let eventStream: AssistantMessageEventStream | undefined;
  const stream = (routing: ManagedInferenceRouting) => {
    eventStream ??= streamOpenRouterGeneration(
      input,
      routing,
      apiKey,
      abortController.signal,
      fetchImpl,
      () => {
        accepted = true;
      },
    );
    return eventStream;
  };
  return {
    stream,
    result: (routing) => stream(routing).result() as Promise<ManagedInferenceResult>,
    accepted: () => accepted,
    abort: async () => {
      abortController.abort();
    },
  };
}

function streamOpenRouterGeneration(
  input: ManagedInferenceRequest,
  routing: ManagedInferenceRouting,
  apiKey: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
  markAccepted: () => void,
): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  const model = openRouterModel(routing);
  const context: Context = {
    ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
    messages: input.messages as Context["messages"],
    ...(input.tools && input.tools.length > 0
      ? { tools: input.tools as Context["tools"] }
      : {}),
  };
  void (async () => {
    try {
      const source = openRouter.streamSimple(model, context, {
        apiKey,
        fetch: fetchImpl,
        signal,
        maxTokens: Math.min(input.maxOutputTokens, routing.maxOutputTokens),
        ...(input.reasoning ? { reasoning: input.reasoning } : {}),
        timeoutMs: input.timeoutMs,
        maxRetries: 0,
        onResponse: (response) => {
          if (response.status >= 200 && response.status < 300) markAccepted();
        },
        headers: {
          "HTTP-Referer": "https://gsv.space",
          "X-Title": "GSV",
        },
      });
      for await (const event of source) {
        output.push(toManagedAssistantEvent(event));
      }
    } catch (error) {
      output.push(managedInferenceErrorEvent(signal.aborted, error));
    }
  })();
  return output;
}

function openRouterModel(
  routing: ManagedInferenceRouting,
): Model<"openai-completions"> {
  const providerRouting = toOpenRouterRouting(routing);
  return {
    id: routing.modelId,
    name: routing.displayName,
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: OPENROUTER_BASE_URL,
    reasoning: routing.reasoning,
    thinkingLevelMap: {
      off: "none",
      minimal: "low",
      low: "low",
      medium: "high",
      high: "high",
      xhigh: "max",
      max: "max",
    },
    input: ["text"],
    cost: {
      input: routing.inputNanoUsdPerToken / 1_000,
      output: routing.outputNanoUsdPerToken / 1_000,
      cacheRead: routing.cacheReadNanoUsdPerToken / 1_000,
      cacheWrite: routing.cacheWriteNanoUsdPerToken / 1_000,
    },
    contextWindow: routing.contextWindow,
    maxTokens: routing.maxOutputTokens,
    compat: {
      supportsDeveloperRole: false,
      thinkingFormat: "openrouter",
      ...(Object.keys(providerRouting).length > 0
        ? { openRouterRouting: providerRouting }
        : {}),
    },
  };
}

function toOpenRouterRouting(
  routing: ManagedInferenceRouting,
): OpenRouterRouting {
  const provider = routing.provider;
  return {
    allow_fallbacks: provider.allowFallbacks,
    require_parameters: provider.requireParameters,
    data_collection: provider.dataCollection,
    zdr: provider.zdr,
    ...(provider.order.length > 0 ? { order: provider.order } : {}),
    ...(provider.only.length > 0 ? { only: provider.only } : {}),
    ...(provider.ignore.length > 0 ? { ignore: provider.ignore } : {}),
    ...(provider.quantizations.length > 0
      ? { quantizations: provider.quantizations }
      : {}),
    ...(provider.sort === "default" ? {} : { sort: provider.sort }),
    ...(provider.preferredMinThroughput === undefined
      ? {}
      : { preferred_min_throughput: provider.preferredMinThroughput }),
    ...(provider.preferredMaxLatency === undefined
      ? {}
      : { preferred_max_latency: provider.preferredMaxLatency }),
  };
}

function toManagedInferenceResult(
  message: AssistantMessage,
): ManagedInferenceResult {
  if (message.stopReason === "pending") {
    throw new Error("OpenRouter generation ended without a terminal result");
  }
  return toManagedInferenceMessage(message) as ManagedInferenceResult;
}

function toManagedInferenceMessage(
  message: AssistantMessage,
): ManagedInferencePartial {
  return {
    role: "assistant",
    content: cloneAssistantContent(message.content),
    api: GSV_INFERENCE_API,
    provider: GSV_INFERENCE_PROVIDER,
    model: GSV_INFERENCE_PRODUCT_MODEL,
    responseModel: message.responseModel ?? message.model,
    ...(message.responseId ? { responseId: message.responseId } : {}),
    usage: message.usage,
    stopReason: message.stopReason,
    ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
    timestamp: message.timestamp,
  };
}

function toManagedAssistantEvent(
  event: AssistantMessageEvent,
): AssistantMessageEvent {
  switch (event.type) {
    case "start":
    case "text_start":
    case "text_delta":
    case "text_end":
    case "thinking_start":
    case "thinking_delta":
    case "thinking_end":
    case "toolcall_start":
    case "toolcall_delta":
      return {
        ...event,
        partial: toManagedInferenceMessage(event.partial) as AssistantMessage,
      } as AssistantMessageEvent;
    case "toolcall_end":
      return {
        ...event,
        toolCall: cloneToolCall(event.toolCall),
        partial: toManagedInferenceMessage(event.partial) as AssistantMessage,
      };
    case "done": {
      const message = toManagedInferenceResult(event.message);
      return { type: "done", reason: event.reason, message };
    }
    case "error": {
      const error = toManagedInferenceResult(event.error);
      return { type: "error", reason: event.reason, error };
    }
  }
}

export function toManagedInferenceStreamEvent(
  event: AssistantMessageEvent,
): ManagedInferenceStreamEvent {
  switch (event.type) {
    case "start":
      return {
        type: "start",
        partial: event.partial as ManagedInferencePartial,
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
      return {
        type: "done",
        reason: event.reason,
        message: event.message as ManagedInferenceResult,
      };
    case "error":
      return {
        type: "error",
        reason: event.reason,
        error: event.error as ManagedInferenceResult,
      };
  }
}

function requireContentBlock<T extends "text" | "thinking" | "toolCall">(
  event: Extract<AssistantMessageEvent, { contentIndex: number }>,
  type: T,
): Extract<ManagedInferenceResult["content"][number], { type: T }> {
  if (!("partial" in event)) {
    throw new Error("Managed inference event has no partial message");
  }
  const block = event.partial.content[event.contentIndex];
  if (!block || block.type !== type) {
    throw new Error(`Managed inference ${type} event has invalid content`);
  }
  if (block.type === "toolCall") {
    return cloneToolCall(block) as Extract<
      ManagedInferenceResult["content"][number],
      { type: T }
    >;
  }
  return { ...block } as Extract<
    ManagedInferenceResult["content"][number],
    { type: T }
  >;
}

function cloneAssistantContent(
  content: AssistantMessage["content"],
): ManagedInferenceResult["content"] {
  return content.map((block) => block.type === "toolCall"
    ? cloneToolCall(block)
    : { ...block }) as ManagedInferenceResult["content"];
}

function cloneToolCall(
  toolCall: Extract<AssistantMessage["content"][number], { type: "toolCall" }>,
): Extract<ManagedInferenceResult["content"][number], { type: "toolCall" }> {
  return {
    ...toolCall,
    arguments: structuredClone(toolCall.arguments),
  } as Extract<ManagedInferenceResult["content"][number], { type: "toolCall" }>;
}

function managedInferenceErrorEvent(
  aborted: boolean,
  error: unknown,
): Extract<AssistantMessageEvent, { type: "error" }> {
  const message: ManagedInferenceResult = {
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
    error: message as AssistantMessage,
  };
}
