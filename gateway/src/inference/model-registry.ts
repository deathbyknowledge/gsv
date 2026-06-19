import { getModels, getProviders, type KnownProvider } from "@earendil-works/pi-ai";

export function resolvePiAiModel(provider: string, modelName: string) {
  if (!isKnownPiAiProvider(provider)) {
    throw new Error(`Unknown model provider: ${provider}`);
  }
  const model = getModels(provider).find((candidate) => candidate.id === modelName);
  if (!model) {
    throw new Error(`Model not found: ${provider}/${modelName}`);
  }
  return model;
}

export function isKnownPiAiProvider(provider: string): provider is KnownProvider {
  return getProviders().includes(provider as KnownProvider);
}
