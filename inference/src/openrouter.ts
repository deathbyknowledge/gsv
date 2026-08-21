import {
  createProvider,
  type AssistantMessage,
  type Context,
  type Model,
  type OpenRouterRouting,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import {
  GSV_INFERENCE_PRODUCT_MODEL,
  GSV_INFERENCE_PROVIDER,
  type ManagedInferenceRequest,
  type ManagedInferenceResult,
  type ManagedInferenceRouting,
} from "@humansandmachines/gsv/protocol";

const GSV_INFERENCE_API = "gsv-inference";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
type OpenRouterGeneration = {
  result: (routing: ManagedInferenceRouting) => Promise<ManagedInferenceResult>;
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
  let resultPromise: Promise<ManagedInferenceResult> | undefined;
  return {
    result: (routing) => {
      resultPromise ??= completeOpenRouterGeneration(
        input,
        routing,
        apiKey,
        abortController.signal,
        fetchImpl,
      );
      return resultPromise;
    },
    abort: async () => {
      abortController.abort();
    },
  };
}

async function completeOpenRouterGeneration(
  input: ManagedInferenceRequest,
  routing: ManagedInferenceRouting,
  apiKey: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<ManagedInferenceResult> {
  const model = openRouterModel(routing);
  const context: Context = {
    ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
    messages: input.messages as Context["messages"],
    ...(input.tools && input.tools.length > 0
      ? { tools: input.tools as Context["tools"] }
      : {}),
  };
  const message = await openRouter.streamSimple(model, context, {
    apiKey,
    fetch: fetchImpl,
    signal,
    maxTokens: Math.min(input.maxOutputTokens, routing.maxOutputTokens),
    ...(input.reasoning ? { reasoning: input.reasoning } : {}),
    timeoutMs: input.timeoutMs,
    maxRetries: 0,
    headers: {
      "HTTP-Referer": "https://gsv.space",
      "X-Title": "GSV",
    },
  }).result();
  return toManagedInferenceResult(message);
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
  return {
    role: "assistant",
    content: message.content as ManagedInferenceResult["content"],
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
