/**
 * The operator-funded `gsv/default` route for the onboarding bench.
 *
 * It mirrors the provider transport of the managed inference service
 * (services/inference/src/generation.ts in the operator's repository): the same
 * pi-ai OpenAI-completions provider, model compat flags, and DeepSeek thinking
 * level map. Admission, accounting and retries are left out because they are not
 * what the bench measures. The base URL points at the bench's recording proxy in
 * Node, which holds the real key; this worker never sees a credential.
 */
import { WorkerEntrypoint, RpcTarget } from "cloudflare:workers";
import { createProvider, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import {
  createInferenceGeneration,
  toInferenceStreamEvent,
  type InferenceTransport,
} from "@humansandmachines/gsv-inference/generation";

import {
  encodeManagedInferenceStreamEvent,
  GSV_INFERENCE_PROVIDER,
  type ManagedInferenceModelRouting,
  type ManagedInferenceRequest,
  type ManagedInferenceResult,
  type ManagedInferenceRouting,
} from "@humansandmachines/gsv/protocol";
import { decodeInferenceRequest, type InferenceRequest } from "@humansandmachines/gsv/services/inference-body";

type Env = { PROXY_BASE_URL: string; MODEL_ID: string; DISPLAY_NAME: string };

const REASONING_MODELS = ["deepseek-ai/DeepSeek-V4.1-Flash", "deepseek-ai/DeepSeek-V4.1-Flash-1017"];

const together = createProvider<"openai-completions">({
  id: "together", name: "Together AI",
  auth: { apiKey: { name: "Recording proxy", resolve: async () => undefined } },
  models: [], api: openAICompletionsApi(),
});

function routing(env: Env): ManagedInferenceRouting {
  return {
    version: 2,
    updatedAt: 0,
    models: [{
      provider: "together",
      modelId: env.MODEL_ID,
      displayName: env.DISPLAY_NAME,
      contextWindow: 1_048_576,
      maxOutputTokens: 32_768,
      reasoning: true,
      inputNanoUsdPerToken: 300,
      outputNanoUsdPerToken: 1200,
      cacheReadNanoUsdPerToken: 6,
      cacheWriteNanoUsdPerToken: 0,
    }],
  };
}

function openAiModel(route: ManagedInferenceModelRouting, baseUrl: string): Model<"openai-completions"> {
  return {
    id: route.modelId,
    name: route.displayName,
    api: "openai-completions",
    provider: "together",
    baseUrl,
    reasoning: route.reasoning,
    thinkingLevelMap: REASONING_MODELS.includes(route.modelId)
      ? { off: "none", minimal: "low", medium: "high", xhigh: "xhigh", max: "max" }
      : { off: "none" },
    input: ["text", "image"],
    contextWindow: route.contextWindow,
    maxTokens: route.maxOutputTokens,
    cost: {
      input: route.inputNanoUsdPerToken / 1_000,
      output: route.outputNanoUsdPerToken / 1_000,
      cacheRead: route.cacheReadNanoUsdPerToken / 1_000,
      cacheWrite: route.cacheWriteNanoUsdPerToken / 1_000,
    },
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
      supportsStrictMode: false,
      maxTokensField: "max_tokens",
    },
  };
}

function transport(env: Env): InferenceTransport {
  const baseUrl = env.PROXY_BASE_URL;
  return {
    fetch: (request, init) => fetch(new Request(request, init), { redirect: "manual" }),
    stream: (route, context, options) => {
      const model = openAiModel(route, baseUrl);
      return together.streamSimple(model, {
        ...context,
        messages: context.messages.map((message) => message.role === "assistant"
          && message.provider === GSV_INFERENCE_PROVIDER && message.responseModel === route.modelId
          ? { ...message, api: model.api, provider: model.provider, model: model.id }
          : message),
      }, { ...options, apiKey: "held-by-the-recording-proxy" });
    },
  };
}

class Target extends RpcTarget {
  readonly #env: Env;
  constructor(env: Env) {
    super();
    this.#env = env;
  }

  async generate(value: InferenceRequest<ManagedInferenceRequest>): Promise<ManagedInferenceResult> {
    const input = await decodeInferenceRequest(value);
    const generation = createInferenceGeneration(input, () => transport(this.#env));
    return generation.result(routing(this.#env)) as Promise<ManagedInferenceResult>;
  }

  async generateStream(value: InferenceRequest<ManagedInferenceRequest>): Promise<ReadableStream<Uint8Array>> {
    const input = await decodeInferenceRequest(value);
    const generation = createInferenceGeneration(input, () => transport(this.#env));
    const source = generation.stream(routing(this.#env));
    const stream = new TransformStream<Uint8Array, Uint8Array>();
    const writer = stream.writable.getWriter();
    void (async () => {
      try {
        for await (const event of source) {
          await writer.write(encodeManagedInferenceStreamEvent(toInferenceStreamEvent(event)));
          if (event.type === "done" || event.type === "error") break;
        }
        await writer.close();
      } catch (error) {
        await writer.abort(error).catch(() => undefined);
      }
    })();
    return stream.readable;
  }

  async abort(): Promise<void> {}
}

export default class BenchFundedInference extends WorkerEntrypoint<Env> {
  async getInstallation(): Promise<Target> {
    return new Target(this.env);
  }
}
