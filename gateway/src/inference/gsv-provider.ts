import {
  createAssistantMessageEventStream,
  createProvider,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type ProviderStreams,
  type SimpleStreamOptions,
  type StreamOptions,
} from "@earendil-works/pi-ai";
import {
  GSV_INFERENCE_FEATURE,
  GSV_INFERENCE_MODEL,
  GSV_INFERENCE_PRODUCT_MODEL,
  GSV_INFERENCE_PROVIDER,
  type ManagedInferenceRequest,
  type ManagedInferenceResult,
  type ManagedInferenceService,
} from "@humansandmachines/gsv/protocol";
import type {
  InferenceAttribution,
  InferenceProviderFactory,
} from "./provider";

const GSV_INFERENCE_API = "gsv-inference";

const GSV_INFERENCE_MODEL_METADATA: Model<typeof GSV_INFERENCE_API> = {
  id: GSV_INFERENCE_MODEL,
  name: "GSV included",
  api: GSV_INFERENCE_API,
  provider: GSV_INFERENCE_PROVIDER,
  baseUrl: "",
  reasoning: true,
  input: ["text"],
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
  contextWindow: 1_048_576,
  maxTokens: 8_192,
};

type GsvInferenceBindings = {
  MANAGED_INFERENCE?: ManagedInferenceService;
};

export function gsvInferenceProviderFactoryFromEnv(
  env: Env,
): InferenceProviderFactory | undefined {
  const service = (env as Env & GsvInferenceBindings).MANAGED_INFERENCE;
  return service ? createGsvInferenceProviderFactory(service) : undefined;
}

export function gsvInferenceFeaturesFromEnv(env: Env): string[] {
  return (env as Env & GsvInferenceBindings).MANAGED_INFERENCE
    ? [GSV_INFERENCE_FEATURE]
    : [];
}

export function createGsvInferenceProviderFactory(
  service: ManagedInferenceService,
): InferenceProviderFactory {
  return {
    id: GSV_INFERENCE_PROVIDER,
    create: (attribution) => createProvider({
      id: GSV_INFERENCE_PROVIDER,
      name: "GSV",
      auth: {
        apiKey: {
          name: "GSV included inference",
          resolve: async () => ({ auth: {}, source: "gateway service binding" }),
        },
      },
      models: [GSV_INFERENCE_MODEL_METADATA],
      api: gsvInferenceStreams(service, attribution),
    }),
  };
}

function gsvInferenceStreams(
  service: ManagedInferenceService,
  attribution: InferenceAttribution,
): ProviderStreams {
  return {
    stream: (_model, context, options) => streamGsvInference(
      service,
      attribution,
      context,
      options,
    ),
    streamSimple: (_model, context, options) => streamGsvInference(
      service,
      attribution,
      context,
      options,
    ),
  };
}

function streamGsvInference(
  service: ManagedInferenceService,
  attribution: InferenceAttribution,
  context: Context,
  options?: StreamOptions | SimpleStreamOptions,
): AssistantMessageEventStream {
  if (options?.fetch) {
    throw new Error("GSV inference cannot originate model requests from a connected machine.");
  }
  const stream = createAssistantMessageEventStream();
  void pumpGsvInference(
    service,
    buildManagedInferenceRequest(attribution, context, options),
    stream,
    options?.signal,
  );
  return stream;
}

function buildManagedInferenceRequest(
  attribution: InferenceAttribution,
  context: Context,
  options?: StreamOptions | SimpleStreamOptions,
): ManagedInferenceRequest {
  const reasoning = "reasoning" in (options ?? {})
    ? (options as SimpleStreamOptions).reasoning
    : undefined;
  return {
    version: 1,
    installationId: attribution.installationId,
    logicalRequestId: attribution.logicalRequestId,
    actor: attribution.actor,
    model: GSV_INFERENCE_PRODUCT_MODEL,
    ...(context.systemPrompt ? { systemPrompt: context.systemPrompt } : {}),
    messages: context.messages as ManagedInferenceRequest["messages"],
    ...(context.tools && context.tools.length > 0
      ? { tools: context.tools as ManagedInferenceRequest["tools"] }
      : {}),
    maxOutputTokens: options?.maxTokens ?? GSV_INFERENCE_MODEL_METADATA.maxTokens,
    ...(reasoning ? { reasoning } : {}),
    timeoutMs: options?.timeoutMs ?? 180_000,
  };
}

async function pumpGsvInference(
  service: ManagedInferenceService,
  request: ManagedInferenceRequest,
  stream: AssistantMessageEventStream,
  signal?: AbortSignal,
): Promise<void> {
  let generationStarted = false;
  let generationAbort: Promise<void> | undefined;
  const abortGeneration = () => {
    if (generationStarted && !generationAbort) {
      generationAbort = (async () => {
        try {
          await service.abort({
            version: 1,
            installationId: request.installationId,
            logicalRequestId: request.logicalRequestId,
          });
        } catch {}
      })();
    }
  };
  signal?.addEventListener("abort", abortGeneration, { once: true });

  try {
    if (signal?.aborted) {
      stream.push(gsvInferenceErrorEvent(true));
      return;
    }
    const resultPromise = service.generate(request);
    generationStarted = true;
    if (signal?.aborted) abortGeneration();
    const result = await resultPromise;
    if (signal?.aborted) {
      stream.push(gsvInferenceErrorEvent(true));
      return;
    }
    pushGsvInferenceResult(stream, result);
  } catch {
    abortGeneration();
    stream.push(gsvInferenceErrorEvent(signal?.aborted === true));
  } finally {
    signal?.removeEventListener("abort", abortGeneration);
    await generationAbort;
  }
}

function pushGsvInferenceResult(
  stream: AssistantMessageEventStream,
  result: ManagedInferenceResult,
): void {
  const message = toAssistantMessage(result);
  if (result.stopReason === "error" || result.stopReason === "aborted") {
    stream.push({
      type: "error",
      reason: result.stopReason,
      error: message,
    });
    return;
  }
  stream.push({
    type: "done",
    reason: result.stopReason,
    message,
  });
}

function toAssistantMessage(message: ManagedInferenceResult): AssistantMessage {
  return {
    ...message,
    content: message.content as AssistantMessage["content"],
  };
}

function gsvInferenceErrorEvent(
  aborted: boolean,
): Extract<AssistantMessageEvent, { type: "error" }> {
  return {
    type: "error",
    reason: aborted ? "aborted" : "error",
    error: {
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
        ? "GSV inference cancelled"
        : "GSV inference is unavailable",
      timestamp: Date.now(),
    },
  };
}
