import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  KnownProvider,
  TextContent,
  ThinkingContent,
  ThinkingLevel,
} from "@earendil-works/pi-ai";
import { completeSimple, getModels, getProviders, streamSimple } from "@earendil-works/pi-ai";
import type { AiConfigResult } from "../syscalls/ai";
import { completeWithWorkersAi, isWorkersAiProvider, streamWithWorkersAi } from "./workers-ai";
import { withTimeout } from "./timeout";

type GenerationPurpose =
  | "chat.reply"
  | "compaction.summary"
  | "thread.title"
  | "mcp.analysis";

type GenerateRequest = {
  purpose: GenerationPurpose;
  config: AiConfigResult;
  context: Context;
  sessionAffinityKey?: string;
};

type GenerationService = {
  generate(request: GenerateRequest): Promise<AssistantMessage>;
  stream(request: GenerateRequest): AssistantMessageEventStream;
  generateText(request: GenerateRequest): Promise<string>;
};

type ResolvedGenerationOptions = {
  modelProvider: string;
  modelName: string;
  apiKey: string;
  reasoning?: ThinkingLevel;
  maxTokens: number;
};

const DEFAULT_GENERATION_TIMEOUT_MS = 180_000;

export function createGenerationService(): GenerationService {
  const stream = (request: GenerateRequest): AssistantMessageEventStream => {
    const options = resolveGenerationOptions(request);
    const generationTimeoutMs = resolveGenerationTimeoutMs(request.config);
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

    const model = resolveModel(options.modelProvider, options.modelName);
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(new Error(generationTimeoutMessage(generationTimeoutMs)));
    }, generationTimeoutMs);
    const result = streamSimple(model, request.context, {
      apiKey: options.apiKey,
      reasoning: options.reasoning,
      maxTokens: options.maxTokens,
      signal: controller.signal,
      timeoutMs: generationTimeoutMs,
    });
    void result.result().then(
      () => clearTimeout(timeout),
      () => clearTimeout(timeout),
    );
    return result;
  };

  const generate = async (request: GenerateRequest): Promise<AssistantMessage> => {
    const options = resolveGenerationOptions(request);
    const generationTimeoutMs = resolveGenerationTimeoutMs(request.config);
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

    const model = resolveModel(options.modelProvider, options.modelName);
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(new Error(generationTimeoutMessage(generationTimeoutMs)));
    }, generationTimeoutMs);
    try {
      return await withTimeout(
        completeSimple(model, request.context, {
          apiKey: options.apiKey,
          reasoning: options.reasoning,
          maxTokens: options.maxTokens,
          signal: controller.signal,
          timeoutMs: generationTimeoutMs,
        }),
        generationTimeoutMs,
        generationTimeoutMessage(generationTimeoutMs),
      );
    } finally {
      clearTimeout(timeout);
    }
  };

  return {
    generate,
    stream,
    async generateText(request: GenerateRequest): Promise<string> {
      const response = await generate(request);
      const text = extractGeneratedText(response);
      if (text) {
        return text;
      }
      throw new Error(`Generation for ${request.purpose} returned no text`);
    },
  };
}

/**
 * Extract usable text from a generation for non-conversational purposes such as
 * compaction summaries and thread titles.
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

export function resolveGenerationOptions(
  request: GenerateRequest,
): ResolvedGenerationOptions {
  const { config, purpose } = request;
  const baseReasoning: ThinkingLevel | undefined =
    config.reasoning && config.reasoning !== "off"
      ? (config.reasoning as ThinkingLevel)
      : undefined;

  switch (purpose) {
    case "thread.title":
      return {
        modelProvider: config.provider,
        modelName: config.model,
        apiKey: config.apiKey,
        reasoning: undefined,
        maxTokens: Math.min(config.maxTokens, 64),
      };
    case "compaction.summary":
      return {
        modelProvider: config.provider,
        modelName: config.model,
        apiKey: config.apiKey,
        reasoning: undefined,
        maxTokens: Math.min(config.maxTokens, 768),
      };
    case "mcp.analysis":
      return {
        modelProvider: config.provider,
        modelName: config.model,
        apiKey: config.apiKey,
        reasoning: baseReasoning,
        maxTokens: config.maxTokens,
      };
    case "chat.reply":
    default:
      return {
        modelProvider: config.provider,
        modelName: config.model,
        apiKey: config.apiKey,
        reasoning: baseReasoning,
        maxTokens: config.maxTokens,
      };
  }
}

export function resolveGenerationTimeoutMs(config: AiConfigResult): number {
  const timeoutMs = (config as Partial<AiConfigResult>).generationTimeoutMs;
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_GENERATION_TIMEOUT_MS;
}

function resolveModel(provider: string, modelName: string) {
  if (!isKnownProvider(provider)) {
    throw new Error(`Unknown model provider: ${provider}`);
  }
  const model = getModels(provider).find((candidate) => candidate.id === modelName);
  if (!model) {
    throw new Error(`Model not found: ${provider}/${modelName}`);
  }
  return model;
}

function generationTimeoutMessage(timeoutMs: number): string {
  return `Model generation timed out after ${timeoutMs}ms`;
}

function isKnownProvider(provider: string): provider is KnownProvider {
  return getProviders().includes(provider as KnownProvider);
}
