import type { AiModelEntry, AiModelStack } from "@humansandmachines/gsv/protocol";
import { z } from "zod";

export const SYSTEM_AI_MODELS_CONFIG_KEY = "config/ai/models";

const MODEL_ENTRY_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const optionalTextSchema = z.string().trim().min(1).optional();
const positiveIntegerSchema = z.number().int().positive().optional();
const storedAiModelEntrySchema = z.object({
  id: z.string().trim().regex(MODEL_ENTRY_ID_PATTERN),
  name: z.string().trim().min(1).max(80),
  provider: z.string().trim().min(1),
  model: z.string().trim().min(1),
  baseUrl: optionalTextSchema,
  providerStyle: optionalTextSchema,
  transportTarget: optionalTextSchema,
  maxTokens: positiveIntegerSchema,
  contextWindowTokens: positiveIntegerSchema,
}).passthrough();
const storedAiModelStackSchema = z.object({
  version: z.literal(1),
  models: z.array(z.unknown()).min(1),
}).passthrough();

export function userAiModelsConfigKey(ownerUid: number): string {
  return `users/${ownerUid}/ai/models`;
}

export function aiModelApiKeyConfigKey(scopeKey: string, modelId: string): string {
  return `${scopeKey}/${modelId}/api_key`;
}

export function parseAiModelStack(raw: string | null | undefined): AiModelStack | null {
  if (!raw?.trim()) {
    return null;
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const payload = storedAiModelStackSchema.safeParse(value);
  if (!payload.success) {
    return null;
  }

  const ids = new Set<string>();
  const models: AiModelEntry[] = [];
  for (const rawModel of payload.data.models) {
    const parsed = storedAiModelEntrySchema.safeParse(rawModel);
    if (!parsed.success || ids.has(parsed.data.id)) {
      return null;
    }
    ids.add(parsed.data.id);
    models.push(copyModelEntry(parsed.data));
  }
  return { version: 1, models };
}

export function orderAiModelStack(
  stack: AiModelStack,
  preferredModelId: string | null | undefined,
): AiModelEntry[] {
  const preferred = preferredModelId?.trim().toLowerCase();
  if (!preferred) {
    return [...stack.models];
  }
  const index = stack.models.findIndex((model) => model.id.toLowerCase() === preferred);
  if (index <= 0) {
    return [...stack.models];
  }
  return [
    stack.models[index],
    ...stack.models.slice(0, index),
    ...stack.models.slice(index + 1),
  ];
}

function copyModelEntry(model: z.infer<typeof storedAiModelEntrySchema>): AiModelEntry {
  const entry: AiModelEntry = {
    id: model.id,
    name: model.name,
    provider: model.provider,
    model: model.model,
  };
  if (model.baseUrl) entry.baseUrl = model.baseUrl;
  if (model.providerStyle) entry.providerStyle = model.providerStyle;
  if (model.transportTarget) entry.transportTarget = model.transportTarget;
  if (model.maxTokens !== undefined) entry.maxTokens = model.maxTokens;
  if (model.contextWindowTokens !== undefined) {
    entry.contextWindowTokens = model.contextWindowTokens;
  }
  return entry;
}
