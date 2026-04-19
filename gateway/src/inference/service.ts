import type {
  AssistantMessage,
  Context,
  KnownProvider,
  ThinkingLevel,
} from "@mariozechner/pi-ai";
import { completeSimple, getModels, getProviders } from "@mariozechner/pi-ai";
import type { AiConfigResult } from "../syscalls/ai";
import { completeWithWorkersAi, isWorkersAiProvider } from "./workers-ai";

export type GenerationPurpose =
  | "chat.reply"
  | "checkpoint.summary"
  | "checkpoint.commit_message"
  | "thread.title"
  | "mcp.analysis";

export type GenerateRequest = {
  purpose: GenerationPurpose;
  config: AiConfigResult;
  context: Context;
  sessionAffinityKey?: string;
};

export type GenerationService = {
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

export function createGenerationService(): GenerationService {
  const generate = async (request: GenerateRequest): Promise<AssistantMessage> => {
    const options = resolveGenerationOptions(request);
    if (isWorkersAiProvider(options.modelProvider)) {
      return completeWithWorkersAi({
        modelName: options.modelName,
        context: request.context,
        reasoning: options.reasoning,
        maxTokens: options.maxTokens,
        sessionAffinityKey: request.sessionAffinityKey,
      });
    }

    const model = resolveModel(options.modelProvider, options.modelName);
    return completeSimple(model, request.context, {
      apiKey: options.apiKey,
      reasoning: options.reasoning,
      maxTokens: options.maxTokens,
    });
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
    case "checkpoint.commit_message":
      return {
        modelProvider: config.provider,
        modelName: config.model,
        apiKey: config.apiKey,
        reasoning: undefined,
        maxTokens: Math.min(config.maxTokens, 128),
      };
    case "thread.title":
      return {
        modelProvider: config.provider,
        modelName: config.model,
        apiKey: config.apiKey,
        reasoning: undefined,
        maxTokens: Math.min(config.maxTokens, 64),
      };
    case "checkpoint.summary":
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

function isKnownProvider(provider: string): provider is KnownProvider {
  return getProviders().includes(provider as KnownProvider);
}
