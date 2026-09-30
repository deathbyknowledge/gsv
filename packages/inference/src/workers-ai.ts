import { createProvider, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import {
  CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL,
  type AiBinding,
} from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import { createAttributedAiBindingFetch } from "./ai-gateway-fetch";
import { getWorkersAiModels } from "./workers-ai-models";
import type { InferenceModelRouting, InferenceRequest } from "./types";
import {
  createInferenceGeneration,
  type InferenceGeneration,
  type InferenceTransport,
} from "./generation";

export {
  toInferenceStreamEvent,
  type InferenceGeneration as WorkersAiGeneration,
  type InferenceAttempt as WorkersAiAttempt,
} from "./generation";

const AI_GATEWAY_ID = "default";
const AI_GATEWAY_BASE_URL =
  `https://workers-binding.ai/ai-gateway/gateways/${AI_GATEWAY_ID}`;
const AI_GATEWAY_COMPAT_URL = `${AI_GATEWAY_BASE_URL}/compat`;
const WORKERS_AI_MODEL_PREFIX = "workers-ai/";
const workersAiCatalog = getWorkersAiModels();

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
): InferenceGeneration {
  const transport = createWorkersAiTransport(input, binding);
  return createInferenceGeneration(input, () => transport);
}

export function createWorkersAiTransport(
  input: InferenceRequest,
  binding: AiBinding,
): InferenceTransport {
  return {
    fetch: createAttributedAiBindingFetch(binding, input),
    stream: (routing, context, options) => workersAi.streamSimple(
      workersAiModel(routing),
      context,
      {
        ...options,
        headers: {
          "cf-aig-authorization":
            `Bearer ${CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL}`,
          "cf-aig-collect-log-payload": "false",
          Authorization: null,
          "x-api-key": null,
        },
      },
    ),
  };
}

function workersAiModel(
  routing: InferenceModelRouting,
): Model<"openai-completions"> {
  const catalogModel = workersAiCatalog.find((model) => model.id === routing.modelId);
  return {
    id: `${WORKERS_AI_MODEL_PREFIX}${routing.modelId}`,
    name: routing.displayName,
    api: "openai-completions",
    provider: "cloudflare-ai-gateway",
    baseUrl: AI_GATEWAY_COMPAT_URL,
    reasoning: routing.reasoning,
    thinkingLevelMap: catalogModel?.thinkingLevelMap,
    input: catalogModel?.input ?? ["text"],
    cost: {
      input: routing.inputNanoUsdPerToken / 1_000,
      output: routing.outputNanoUsdPerToken / 1_000,
      cacheRead: routing.cacheReadNanoUsdPerToken / 1_000,
      cacheWrite: routing.cacheWriteNanoUsdPerToken / 1_000,
    },
    contextWindow: routing.contextWindow,
    maxTokens: routing.maxOutputTokens,
    compat: {
      // Model-specific controls translate reasoning off into a provider request.
      // Routing still owns the limits, prices and binding transport above.
      ...catalogModel?.compat,
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
