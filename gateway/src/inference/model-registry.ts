import {
  clampThinkingLevel,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import {
  type BuiltinProvider,
  getBuiltinModels,
  getBuiltinProviders,
} from "@earendil-works/pi-ai/providers/all";

const WORKERS_AI_REGISTRY_PROVIDER: BuiltinProvider = "cloudflare-workers-ai";
const MODEL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const satisfies readonly ModelThinkingLevel[];
const MODEL_THINKING_LEVEL_SET = new Set<string>(MODEL_THINKING_LEVELS);

export function resolvePiAiModel(provider: string, modelName: string) {
  if (!isKnownPiAiProvider(provider)) {
    throw new Error(`Unknown model provider: ${provider}`);
  }
  const model = getBuiltinModels(provider).find((candidate) => candidate.id === modelName);
  if (!model) {
    throw new Error(`Model not found: ${provider}/${modelName}`);
  }
  return model;
}

export function isKnownPiAiProvider(provider: string): provider is BuiltinProvider {
  return getBuiltinProviders().includes(provider as BuiltinProvider);
}

export function normalizeModelThinkingLevel(value: unknown): ModelThinkingLevel | null {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return MODEL_THINKING_LEVEL_SET.has(normalized) ? normalized as ModelThinkingLevel : null;
}

export function resolveModelThinkingLevel(
  provider: string,
  modelName: string,
  value: unknown,
): ModelThinkingLevel | null {
  const requested = normalizeModelThinkingLevel(value);
  if (!requested) {
    return null;
  }
  const model = resolveModelMetadata(provider, modelName);
  return model ? clampThinkingLevel(model, requested) : requested;
}

export function resolveModelMetadata(provider: string, modelName: string) {
  const registryProvider = registryProviderFor(provider);
  if (!isKnownPiAiProvider(registryProvider)) {
    return null;
  }
  return getBuiltinModels(registryProvider).find((candidate) => candidate.id === modelName) ?? null;
}

export function resolveModelContextWindowFromRegistry(provider: string, modelName: string): number | null {
  const model = resolveModelMetadata(provider, modelName);
  return Number.isSafeInteger(model?.contextWindow) && model!.contextWindow > 0
    ? model!.contextWindow
    : null;
}

function registryProviderFor(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  if (normalized === "workers-ai" || normalized === "workersai") {
    return WORKERS_AI_REGISTRY_PROVIDER;
  }
  return provider;
}
