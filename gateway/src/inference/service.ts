import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  TextContent,
  ThinkingContent,
  ThinkingLevel,
} from "@earendil-works/pi-ai";
import type { AiConfigResult, AiTextGenerateOptions } from "../syscalls/ai";
import { completeWithWorkersAi, isWorkersAiProvider, streamWithWorkersAi } from "./workers-ai";
import { withTimeout } from "./timeout";
import { resolveModelThinkingLevel, resolvePiAiModel } from "./model-registry";
import { completePiAiSimple, streamPiAiSimple } from "./pi-ai";
import {
  errorMessageFromUnknown,
  formatProviderErrorMessage,
} from "./errors";
import {
  completeWithCustomProvider,
  shouldUseCustomProvider,
  streamWithCustomProvider,
} from "./custom-provider";

const GENERATION_SERVICE_MARKER = "__gsvGenerationService";

const OPENROUTER_ATTR_HEADERS = {
  "HTTP-Referer": "https://gsv.space",
  "X-OpenRouter-Title": "GSV",
  "X-OpenRouter-Categories": "personal-agent",
};

type GenerateRequest = {
  config: AiConfigResult;
  context: Context;
  options?: AiTextGenerateOptions;
  fetch?: typeof fetch;
  sessionAffinityKey?: string;
};

type GenerationService = {
  readonly [GENERATION_SERVICE_MARKER]: true;
  generate(request: GenerateRequest): Promise<AssistantMessage>;
  stream(request: GenerateRequest): AssistantMessageEventStream;
  generateText(request: GenerateRequest): Promise<string>;
};

type GenerationServiceOptions = {
  fetch?: typeof fetch;
};

type ResolvedGenerationOptions = {
  modelProvider: string;
  modelName: string;
  apiKey: string;
  baseUrl?: string;
  providerStyle?: string;
  fetch?: typeof fetch;
  reasoning?: ThinkingLevel;
  maxTokens: number;
};

const DEFAULT_GENERATION_TIMEOUT_MS = 180_000;

export function createGenerationService(
  serviceOptions: GenerationServiceOptions = {},
): GenerationService {
  const stream = (request: GenerateRequest): AssistantMessageEventStream => {
    const options = resolveGenerationOptions(request);
    const generationTimeoutMs = resolveGenerationTimeoutMs(request.config, request.options);
    if (isWorkersAiProvider(options.modelProvider)) {
      return streamWithWorkersAi({
        modelName: options.modelName,
        context: request.context,
        reasoning: options.reasoning,
        maxTokens: options.maxTokens,
        sessionAffinityKey: request.sessionAffinityKey,
        timeoutMs: generationTimeoutMs,
      });
    }
    if (shouldUseCustomProvider({
      provider: options.modelProvider,
      baseUrl: options.baseUrl,
      providerStyle: options.providerStyle,
    })) {
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort(new Error(generationTimeoutMessage(generationTimeoutMs)));
      }, generationTimeoutMs);
      const result = streamWithCustomProvider({
        provider: options.modelProvider,
        model: options.modelName,
        apiKey: options.apiKey,
        baseUrl: options.baseUrl,
        providerStyle: options.providerStyle,
        fetch: options.fetch ?? serviceOptions.fetch,
        contextWindowTokens: request.config.contextWindowTokens,
        maxTokens: options.maxTokens,
        context: request.context,
        options: {
          reasoning: options.reasoning,
          maxTokens: options.maxTokens,
          signal: controller.signal,
          timeoutMs: generationTimeoutMs,
        },
      });
      void result.result().then(
        () => clearTimeout(timeout),
        () => clearTimeout(timeout),
      );
      return result;
    }

    const model = resolvePiAiModel(options.modelProvider, options.modelName);
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(new Error(generationTimeoutMessage(generationTimeoutMs)));
    }, generationTimeoutMs);
    const result = streamPiAiSimple(model, request.context, {
      apiKey: options.apiKey,
      reasoning: options.reasoning,
      maxTokens: options.maxTokens,
      signal: controller.signal,
      timeoutMs: generationTimeoutMs,
      headers: {
        ...(options.modelProvider === "openrouter" ? OPENROUTER_ATTR_HEADERS : {})
      },
    });
    void result.result().then(
      () => clearTimeout(timeout),
      () => clearTimeout(timeout),
    );
    return result;
  };

  const generate = async (request: GenerateRequest): Promise<AssistantMessage> => {
    const options = resolveGenerationOptions(request);
    const generationTimeoutMs = resolveGenerationTimeoutMs(request.config, request.options);
    if (isWorkersAiProvider(options.modelProvider)) {
      return completeWithWorkersAi({
        modelName: options.modelName,
        context: request.context,
        reasoning: options.reasoning,
        maxTokens: options.maxTokens,
        sessionAffinityKey: request.sessionAffinityKey,
        timeoutMs: generationTimeoutMs,
      });
    }
    if (shouldUseCustomProvider({
      provider: options.modelProvider,
      baseUrl: options.baseUrl,
      providerStyle: options.providerStyle,
    })) {
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort(new Error(generationTimeoutMessage(generationTimeoutMs)));
      }, generationTimeoutMs);
      try {
        return await withTimeout(
          completeWithCustomProvider({
            provider: options.modelProvider,
            model: options.modelName,
            apiKey: options.apiKey,
            baseUrl: options.baseUrl,
            providerStyle: options.providerStyle,
            fetch: options.fetch ?? serviceOptions.fetch,
            contextWindowTokens: request.config.contextWindowTokens,
            maxTokens: options.maxTokens,
            context: request.context,
            options: {
              reasoning: options.reasoning,
              maxTokens: options.maxTokens,
              signal: controller.signal,
              timeoutMs: generationTimeoutMs,
            },
          }),
          generationTimeoutMs,
          generationTimeoutMessage(generationTimeoutMs),
        );
      } finally {
        clearTimeout(timeout);
      }
    }

    const model = resolvePiAiModel(options.modelProvider, options.modelName);
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(new Error(generationTimeoutMessage(generationTimeoutMs)));
    }, generationTimeoutMs);
    try {
      return await withTimeout(
        completePiAiSimple(model, request.context, {
          apiKey: options.apiKey,
          reasoning: options.reasoning,
          maxTokens: options.maxTokens,
          signal: controller.signal,
          timeoutMs: generationTimeoutMs,
          headers: {
            ...(options.modelProvider === "openrouter" ? OPENROUTER_ATTR_HEADERS : {})
          },
        }),
        generationTimeoutMs,
        generationTimeoutMessage(generationTimeoutMs),
      );
    } finally {
      clearTimeout(timeout);
    }
  };

  return {
    [GENERATION_SERVICE_MARKER]: true,
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

export function isGenerationService(value: unknown): value is GenerationService {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as { [GENERATION_SERVICE_MARKER]?: unknown })[GENERATION_SERVICE_MARKER] === true,
  );
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
  return {
    modelProvider: config.provider,
    modelName: config.model,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    providerStyle: config.providerStyle,
    fetch: request.fetch,
    reasoning: resolveGenerationReasoning(config, request.options),
    maxTokens: resolveGenerationMaxTokens(config, request.options),
  };
}

export function resolveGenerationTimeoutMs(
  config: AiConfigResult,
  options?: Pick<AiTextGenerateOptions, "timeoutMs">,
): number {
  const timeoutMs = normalizePositiveNumber(options?.timeoutMs)
    ?? (config as Partial<AiConfigResult>).generationTimeoutMs;
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_GENERATION_TIMEOUT_MS;
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

function normalizePositiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function generationReasoningFromLevel(level: ReturnType<typeof resolveModelThinkingLevel>): ThinkingLevel | null {
  return level && level !== "off" ? level : null;
}

function generationTimeoutMessage(timeoutMs: number): string {
  return `Model generation timed out after ${timeoutMs}ms`;
}
