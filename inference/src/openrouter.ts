import {
  createProvider,
  type AssistantMessage,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import {
  GSV_INFERENCE_PRODUCT_MODEL,
  GSV_INFERENCE_PROVIDER,
  type ManagedInferenceGeneration,
  type ManagedInferenceRequest,
  type ManagedInferenceResult,
} from "@humansandmachines/gsv/protocol";

const GSV_INFERENCE_API = "gsv-inference";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_MODEL_ID = "deepseek/deepseek-v4-flash-0731";

const OPENROUTER_MODEL: Model<"openai-completions"> = {
  id: OPENROUTER_MODEL_ID,
  name: "DeepSeek: DeepSeek V4 Flash 0731",
  api: "openai-completions",
  provider: "openrouter",
  baseUrl: OPENROUTER_BASE_URL,
  reasoning: true,
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
    input: 0.08,
    output: 0.18,
    cacheRead: 0.016,
    cacheWrite: 0,
  },
  contextWindow: 1_048_576,
  maxTokens: 384_000,
  compat: {
    supportsDeveloperRole: false,
    thinkingFormat: "openrouter",
  },
};

const openRouter = createProvider({
  id: "openrouter",
  name: "OpenRouter",
  baseUrl: OPENROUTER_BASE_URL,
  auth: {
    apiKey: {
      name: "OpenRouter API key",
      resolve: async () => ({ auth: {}, source: "inference service secret" }),
    },
  },
  models: [OPENROUTER_MODEL],
  api: openAICompletionsApi(),
});

export function createOpenRouterGeneration(
  input: ManagedInferenceRequest,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): ManagedInferenceGeneration {
  if (input.model !== GSV_INFERENCE_PRODUCT_MODEL) {
    throw new Error(`Unsupported managed inference model: ${input.model}`);
  }
  if (!apiKey.trim()) {
    throw new Error("Managed inference credential is not configured");
  }

  const abortController = new AbortController();
  let resultPromise: Promise<ManagedInferenceResult> | undefined;
  return {
    result: () => {
      resultPromise ??= completeOpenRouterGeneration(
        input,
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
  apiKey: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<ManagedInferenceResult> {
  const context: Context = {
    ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
    messages: input.messages as Context["messages"],
    ...(input.tools && input.tools.length > 0
      ? { tools: input.tools as Context["tools"] }
      : {}),
  };
  const message = await openRouter.streamSimple(OPENROUTER_MODEL, context, {
    apiKey,
    fetch: fetchImpl,
    signal,
    maxTokens: input.maxOutputTokens,
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
