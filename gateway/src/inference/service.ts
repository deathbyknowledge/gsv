import type {
  AssistantMessage,
  Context,
  KnownProvider,
  ThinkingLevel,
} from "@earendil-works/pi-ai";
import { completeSimple, getModels, getProviders } from "@earendil-works/pi-ai";
import type { AiConfigResult } from "../syscalls/ai";
import { completeWithWorkersAi, isWorkersAiProvider } from "./workers-ai";
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
    async generateText(request: GenerateRequest): Promise<string> {
      const response = await generate(request);
      const text = response.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("")
        .trim();
      if (!text) {
        throw new Error(`Generation for ${request.purpose} returned no text`);
      }
      return text;
    },
  };
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
