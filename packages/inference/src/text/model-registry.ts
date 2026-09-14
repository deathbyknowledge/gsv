import {
  clampThinkingLevel,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import {
  type BuiltinProvider,
  getBuiltinModels,
  getBuiltinProviders,
} from "@earendil-works/pi-ai/providers/all";
import * as z from "zod/mini";

const WORKERS_AI_REGISTRY_PROVIDER: BuiltinProvider = "cloudflare-workers-ai";
const MODEL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const satisfies readonly ModelThinkingLevel[];

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
  // SAFETY: the registry provider list is the authoritative BuiltinProvider set.
  return getBuiltinProviders().includes(provider as BuiltinProvider);
}

export function normalizeModelThinkingLevel<T>(value: T): ModelThinkingLevel | null {
  const parsed = z.string().safeParse(value);
  if (!parsed.success) return null;
  const normalized = parsed.data.trim().toLowerCase();
  return MODEL_THINKING_LEVELS.find((level) => level === normalized) ?? null;
}

export function resolveModelThinkingLevel(
  provider: string,
  modelName: string,
  value: string | null | undefined,
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
  const contextWindow = model?.contextWindow;
  if (contextWindow === undefined) return null;
  return Number.isSafeInteger(contextWindow) && contextWindow > 0 ? contextWindow : null;
}

function registryProviderFor(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  if (normalized === "workers-ai" || normalized === "workersai") {
    return WORKERS_AI_REGISTRY_PROVIDER;
  }
  return provider;
}
