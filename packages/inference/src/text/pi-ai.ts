import {
  createModels,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type Models,
  type Provider,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

const models = builtinModels();

export function streamPiAiSimple(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
  runtimeModels: Models = models,
): AssistantMessageEventStream {
  return runtimeModels.streamSimple(model, context, options);
}

export function completePiAiSimple(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
  runtimeModels: Models = models,
): Promise<AssistantMessage> {
  return runtimeModels.completeSimple(model, context, options);
}

export function modelsWithProviders(providers: readonly Provider[]): Models {
  if (providers.length === 0) {
    return models;
  }
  const runtimeModels = createModels();
  for (const provider of providers) {
    runtimeModels.setProvider(provider);
  }
  return runtimeModels;
}
