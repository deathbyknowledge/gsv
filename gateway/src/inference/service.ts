import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  Models,
  TextContent,
  ThinkingContent,
  ThinkingLevel,
} from "@earendil-works/pi-ai";
import {
  type AiConfigResult,
  type AiTextGenerateOptions,
} from "@humansandmachines/gsv/protocol";
import { completeWithWorkersAi, isWorkersAiProvider, streamWithWorkersAi } from "./workers-ai";
import { withTimeout } from "./timeout";
import { resolveModelThinkingLevel, resolvePiAiModel } from "./model-registry";
import {
  completePiAiSimple,
  modelsWithProviders,
  streamPiAiSimple,
} from "./pi-ai";
import {
  errorMessageFromUnknown,
  formatProviderErrorMessage,
} from "./errors";
import {
  completeWithCustomProvider,
  shouldUseCustomProvider,
  streamWithCustomProvider,
} from "./custom-provider";
import {
  completeWithOpenAiCodexFetch,
  streamWithOpenAiCodexFetch,
} from "./openai-codex";
import type {
  InferenceAttribution,
  InferenceProviderFactory,
} from "./provider";
import * as z from "zod/mini";

const OPENROUTER_ATTR_HEADERS = {
  "HTTP-Referer": "https://gsv.space",
  "X-OpenRouter-Title": "GSV",
  "X-OpenRouter-Categories": "personal-agent",
};
const OPENAI_CODEX_PROVIDER = "openai-codex";

type GenerateRequest = {
  config: AiConfigResult;
  context: Context;
  options?: AiTextGenerateOptions;
  fetch?: typeof fetch;
  sessionAffinityKey?: string;
  signal?: AbortSignal;
  attribution?: InferenceAttribution;
};

type GenerationService = {
  generate(request: GenerateRequest): Promise<AssistantMessage>;
  stream(request: GenerateRequest): AssistantMessageEventStream;
  generateText(request: GenerateRequest): Promise<string>;
};

type GenerationServiceOptions = {
  fetch?: typeof fetch;
  providers?: readonly InferenceProviderFactory[];
  transports?: Partial<GenerationTransports>;
};

export type GenerationTransports = {
  completePiAiSimple: typeof completePiAiSimple;
  streamPiAiSimple: typeof streamPiAiSimple;
  completeWithOpenAiCodexFetch: typeof completeWithOpenAiCodexFetch;
  streamWithOpenAiCodexFetch: typeof streamWithOpenAiCodexFetch;
};

type ResolvedGenerationOptions = {
  modelProvider: string;
  modelName: string;
  apiKey: string;
  baseUrl?: string;
  providerStyle?: string;
  openAiCodexAccountId?: string;
  reasoning?: ThinkingLevel;
  maxTokens: number;
};

type PiAiProviderModel = { models: Models; model: Model<Api> };

const DEFAULT_GENERATION_TIMEOUT_MS = 180_000;

export function createGenerationService(
  serviceOptions: GenerationServiceOptions = {},
): GenerationService {
  const transports: GenerationTransports = {
    completePiAiSimple,
    streamPiAiSimple,
    completeWithOpenAiCodexFetch,
    streamWithOpenAiCodexFetch,
    ...serviceOptions.transports,
  };
  const stream = (request: GenerateRequest): AssistantMessageEventStream => {
    const options = resolveGenerationOptions(request);
    const generationFetch = request.fetch ?? serviceOptions.fetch;
    const generationTimeoutMs = resolveGenerationTimeoutMs(request.config, request.options);
    const providerFactory = findInferenceProviderFactory(
      serviceOptions,
      options.modelProvider,
    );
    if (isWorkersAiProvider(options.modelProvider)) {
      if (generationFetch) {
        throw new Error("Workers AI uses a gateway binding and cannot originate model requests from a machine.");
      }
      return streamWithWorkersAi({
        modelName: options.modelName,
        context: request.context,
        reasoning: options.reasoning,
        maxTokens: options.maxTokens,
        sessionAffinityKey: request.sessionAffinityKey,
        timeoutMs: generationTimeoutMs,
        signal: request.signal,
      });
    }
    if (
      options.modelProvider !== OPENAI_CODEX_PROVIDER &&
      !providerFactory &&
      shouldUseCustomProvider({
        provider: options.modelProvider,
        baseUrl: options.baseUrl,
        providerStyle: options.providerStyle,
      })
    ) {
      const abort = createGenerationAbort(request.signal, generationTimeoutMs);
      const result = streamWithCustomProvider({
        provider: options.modelProvider,
        model: options.modelName,
        apiKey: options.apiKey,
        baseUrl: options.baseUrl,
        providerStyle: options.providerStyle,
        fetch: generationFetch,
        contextWindowTokens: request.config.contextWindowTokens,
        maxTokens: options.maxTokens,
        context: request.context,
        options: {
          reasoning: options.reasoning,
          maxTokens: options.maxTokens,
          signal: abort.signal,
          timeoutMs: generationTimeoutMs,
        },
      });
      void result.result().then(
        abort.clear,
        abort.clear,
      );
      return result;
    }

    assertOpenAiCodexCredential(options.modelProvider, options.apiKey);
    const piAi = resolvePiAiProviderModel(providerFactory, request, options);
    const abort = createGenerationAbort(request.signal, generationTimeoutMs);
    const openAiCodexFetch = options.modelProvider === OPENAI_CODEX_PROVIDER
      ? generationFetch ?? fetch
      : undefined;
    if (openAiCodexFetch) {
      const result = transports.streamWithOpenAiCodexFetch({
        model: piAi.model,
        context: request.context,
        fetch: openAiCodexFetch,
        options: {
          apiKey: options.apiKey,
          openAiCodexAccountId: options.openAiCodexAccountId,
          reasoning: options.reasoning,
          maxTokens: options.maxTokens,
          signal: abort.signal,
          timeoutMs: generationTimeoutMs,
          ...resolvePiAiTransportOptions(options.modelProvider, request.sessionAffinityKey),
        },
      });
      void result.result().then(
        abort.clear,
        abort.clear,
      );
      return result;
    }
    const result = transports.streamPiAiSimple(piAi.model, request.context, {
      apiKey: options.apiKey,
      fetch: generationFetch,
      reasoning: options.reasoning,
      maxTokens: options.maxTokens,
      signal: abort.signal,
      timeoutMs: generationTimeoutMs,
      ...resolvePiAiTransportOptions(options.modelProvider, request.sessionAffinityKey),
      headers: options.modelProvider === "openrouter" ? OPENROUTER_ATTR_HEADERS : {},
    }, piAi.models);
    void result.result().then(
      abort.clear,
      abort.clear,
    );
    return result;
  };

  const generate = async (request: GenerateRequest): Promise<AssistantMessage> => {
    const options = resolveGenerationOptions(request);
    const generationFetch = request.fetch ?? serviceOptions.fetch;
    const generationTimeoutMs = resolveGenerationTimeoutMs(request.config, request.options);
    const providerFactory = findInferenceProviderFactory(
      serviceOptions,
      options.modelProvider,
    );
    if (isWorkersAiProvider(options.modelProvider)) {
      if (generationFetch) {
        throw new Error("Workers AI uses a gateway binding and cannot originate model requests from a machine.");
      }
      return completeWithWorkersAi({
        modelName: options.modelName,
        context: request.context,
        reasoning: options.reasoning,
        maxTokens: options.maxTokens,
        sessionAffinityKey: request.sessionAffinityKey,
        timeoutMs: generationTimeoutMs,
        signal: request.signal,
      });
    }
    if (
      options.modelProvider !== OPENAI_CODEX_PROVIDER &&
      !providerFactory &&
      shouldUseCustomProvider({
        provider: options.modelProvider,
        baseUrl: options.baseUrl,
        providerStyle: options.providerStyle,
      })
    ) {
      const abort = createGenerationAbort(request.signal, generationTimeoutMs);
      try {
        return await withTimeout(
          completeWithCustomProvider({
            provider: options.modelProvider,
            model: options.modelName,
            apiKey: options.apiKey,
            baseUrl: options.baseUrl,
            providerStyle: options.providerStyle,
            fetch: generationFetch,
            contextWindowTokens: request.config.contextWindowTokens,
            maxTokens: options.maxTokens,
            context: request.context,
            options: {
              reasoning: options.reasoning,
              maxTokens: options.maxTokens,
              signal: abort.signal,
              timeoutMs: generationTimeoutMs,
            },
          }),
          generationTimeoutMs,
          generationTimeoutMessage(generationTimeoutMs),
        );
      } finally {
        abort.clear();
      }
    }

    assertOpenAiCodexCredential(options.modelProvider, options.apiKey);
    const piAi = resolvePiAiProviderModel(providerFactory, request, options);
    const abort = createGenerationAbort(request.signal, generationTimeoutMs);
    const openAiCodexFetch = options.modelProvider === OPENAI_CODEX_PROVIDER
      ? generationFetch ?? fetch
      : undefined;
    try {
      if (openAiCodexFetch) {
        return await withTimeout(
          transports.completeWithOpenAiCodexFetch({
            model: piAi.model,
            context: request.context,
            fetch: openAiCodexFetch,
            options: {
              apiKey: options.apiKey,
              openAiCodexAccountId: options.openAiCodexAccountId,
              reasoning: options.reasoning,
              maxTokens: options.maxTokens,
              signal: abort.signal,
              timeoutMs: generationTimeoutMs,
              ...resolvePiAiTransportOptions(options.modelProvider, request.sessionAffinityKey),
            },
          }),
          generationTimeoutMs,
          generationTimeoutMessage(generationTimeoutMs),
        );
      }
      return await withTimeout(
        transports.completePiAiSimple(piAi.model, request.context, {
          apiKey: options.apiKey,
          fetch: generationFetch,
          reasoning: options.reasoning,
          maxTokens: options.maxTokens,
          signal: abort.signal,
          timeoutMs: generationTimeoutMs,
          ...resolvePiAiTransportOptions(options.modelProvider, request.sessionAffinityKey),
          headers: options.modelProvider === "openrouter" ? OPENROUTER_ATTR_HEADERS : {},
        }, piAi.models),
        generationTimeoutMs,
        generationTimeoutMessage(generationTimeoutMs),
      );
    } finally {
      abort.clear();
    }
  };

  return {
    generate,
    stream,
    async generateText(request: GenerateRequest): Promise<string> {
      let response: AssistantMessage;
      try {
        response = await generate(request);
      } catch (error) {
        const message = errorMessageFromUnknown(error);
        const formatted = formatProviderErrorMessage(message, {
          provider: request.config.provider,
          model: request.config.model,
        });
        if (!formatted || formatted === message) {
          throw error;
        }
        throw new Error(formatted);
      }

      const text = extractGeneratedText(response);
      if (text) {
        return text;
      }
      throw new Error(describeGeneratedTextFailure(request, response));
    },
  };
}

function findInferenceProviderFactory(
  serviceOptions: GenerationServiceOptions,
  provider: string,
): InferenceProviderFactory | undefined {
  const providerId = provider.trim().toLowerCase();
  return serviceOptions.providers?.find(
    (candidate) => candidate.id.trim().toLowerCase() === providerId,
  );
}

function resolvePiAiProviderModel(
  factory: InferenceProviderFactory | undefined,
  request: GenerateRequest,
  options: ResolvedGenerationOptions,
): PiAiProviderModel {
  if (!factory) {
    return {
      models: modelsWithProviders([]),
      model: resolvePiAiModel(options.modelProvider, options.modelName),
    };
  }
  if (!request.attribution) {
    throw new Error(`Inference attribution is unavailable for provider: ${factory.id}`);
  }
  const provider = factory.create(request.attribution);
  const models = modelsWithProviders([provider]);
  const model = models.getModel(provider.id, options.modelName);
  if (!model) {
    throw new Error(`Model not found: ${options.modelProvider}/${options.modelName}`);
  }
  return { models, model };
}

type PiAiTransportOptions = { transport?: "sse"; sessionId?: string };

function resolvePiAiTransportOptions(
  provider: string,
  sessionAffinityKey?: string,
): PiAiTransportOptions {
  if (provider !== OPENAI_CODEX_PROVIDER) {
    return {};
  }
  return sessionAffinityKey
    ? { transport: "sse", sessionId: sessionAffinityKey }
    : { transport: "sse" };
}

function assertOpenAiCodexCredential(provider: string, apiKey: string): void {
  if (provider === OPENAI_CODEX_PROVIDER && !apiKey.trim()) {
    throw new Error("OpenAI Codex is not connected. Connect OpenAI Codex before using this model.");
  }
}

/**
 * Extract usable text from a generation for non-conversational callers such as
 * compaction summaries and ai.text.generate.
 *
 * Reasoning models (notably Workers AI ones such as kimi-k2.6) sometimes emit
 * their answer in a reasoning/thinking channel and produce no separate text
 * block when thinking is disabled. Falling back to that reasoning text keeps the
 * run alive instead of hard-failing with "returned no text".
 */
export function extractGeneratedText(response: AssistantMessage): string {
  const text = response.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
  if (text) {
    return text;
  }

  return response.content
    .filter((block): block is ThinkingContent => block.type === "thinking")
    .map((block) => block.thinking)
    .join("")
    .trim();
}

export function describeGeneratedTextFailure(
  request: {
    config: Pick<AiConfigResult, "provider" | "model">;
  },
  response: AssistantMessage,
): string {
  if (
    (response.stopReason === "error" || response.stopReason === "aborted") &&
    response.errorMessage
  ) {
    return formatProviderErrorMessage(response.errorMessage, {
      provider: request.config.provider,
      model: request.config.model,
    });
  }
  return "Generation returned no text";
}

export function resolveGenerationOptions(
  request: GenerateRequest,
): ResolvedGenerationOptions {
  const { config } = request;
  const openAiCodexAccountId = config.openAiCodex?.accountId?.trim();
  const resolved: ResolvedGenerationOptions = {
    modelProvider: config.provider,
    modelName: config.model,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    providerStyle: config.providerStyle,
    reasoning: resolveGenerationReasoning(config, request.options),
    maxTokens: resolveGenerationMaxTokens(config, request.options),
  };
  if (openAiCodexAccountId) resolved.openAiCodexAccountId = openAiCodexAccountId;
  return resolved;
}

export function resolveGenerationTimeoutMs(
  config: AiConfigResult,
  options?: Pick<AiTextGenerateOptions, "timeoutMs">,
): number {
  // SAFETY: The persisted AI config may include the optional generation timeout field.
  const timeoutMs = normalizePositiveNumber(options?.timeoutMs)
    ?? (config as Partial<AiConfigResult>).generationTimeoutMs;
  return normalizePositiveNumber(timeoutMs) ?? DEFAULT_GENERATION_TIMEOUT_MS;
}

function resolveGenerationReasoning(
  config: AiConfigResult,
  options?: Pick<AiTextGenerateOptions, "reasoning">,
): ThinkingLevel | undefined {
  const requested = options?.reasoning;
  if (requested === "off") {
    return undefined;
  }
  const level = requested && requested !== "inherit"
    ? requested
    : config.reasoning;
  return generationReasoningFromLevel(resolveModelThinkingLevel(config.provider, config.model, level))
    ?? undefined;
}

function resolveGenerationMaxTokens(
  config: AiConfigResult,
  options?: Pick<AiTextGenerateOptions, "maxTokens">,
): number {
  const maxTokens = normalizePositiveNumber(options?.maxTokens);
  return maxTokens ? Math.min(config.maxTokens, Math.floor(maxTokens)) : config.maxTokens;
}

function normalizePositiveNumber(value: number | null | undefined): number | null {
  const parsed = z.number().safeParse(value);
  return parsed.success && Number.isFinite(parsed.data) && parsed.data > 0
    ? parsed.data
    : null;
}

function generationReasoningFromLevel(level: ReturnType<typeof resolveModelThinkingLevel>): ThinkingLevel | null {
  return level && level !== "off" ? level : null;
}

function generationTimeoutMessage(timeoutMs: number): string {
  return `Model generation timed out after ${timeoutMs}ms`;
}

type GenerationAbort = { signal: AbortSignal; clear: () => void };

function createGenerationAbort(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): GenerationAbort {
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => {
    timeoutController.abort(new Error(generationTimeoutMessage(timeoutMs)));
  }, timeoutMs);
  return {
    signal: callerSignal
      ? AbortSignal.any([callerSignal, timeoutController.signal])
      : timeoutController.signal,
    clear: () => clearTimeout(timeout),
  };
}
