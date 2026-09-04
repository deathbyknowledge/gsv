import type { AiModelEntry, AiModelSource, AiModelStack } from "@humansandmachines/gsv/protocol";
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
}).strict();
const storedAiModelStackSchema = z.object({
  version: z.literal(1),
  models: z.array(z.unknown()).min(1),
}).strict();

export function userAiModelsConfigKey(ownerUid: number): string {
  return `users/${ownerUid}/ai/models`;
}

export function aiModelApiKeyConfigKey(scopeKey: string, modelId: string): string {
  return `${scopeKey}/${modelId}/api_key`;
}

export function parseAiModelApiKeyConfigKey(
  key: string,
): { stackKey: string; modelId: string } | null {
  const match = /^(config\/ai\/models|users\/\d+\/ai\/models)\/([^/]+)\/api_key$/.exec(key);
  return match ? { stackKey: match[1], modelId: match[2] } : null;
}

export function isAiModelStackConfigKey(key: string): boolean {
  return key === SYSTEM_AI_MODELS_CONFIG_KEY || /^users\/\d+\/ai\/models$/.test(key);
}

export function isSameAiModelCredentialScope(
  left: Pick<AiModelEntry, "provider" | "model" | "baseUrl" | "providerStyle" | "transportTarget">,
  right: Pick<AiModelEntry, "provider" | "model" | "baseUrl" | "providerStyle" | "transportTarget">,
): boolean {
  return left.provider.trim().toLowerCase() === right.provider.trim().toLowerCase() &&
    left.model.trim() === right.model.trim() &&
    normalizeOptionalText(left.baseUrl) === normalizeOptionalText(right.baseUrl) &&
    (normalizeOptionalText(left.providerStyle)?.toLowerCase() ?? "auto") ===
      (normalizeOptionalText(right.providerStyle)?.toLowerCase() ?? "auto") &&
    normalizeTransportTarget(left.transportTarget) === normalizeTransportTarget(right.transportTarget);
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

/** One entry of the effective stack with the layer it came from and where its credential lives. */
export type EffectiveAiModelEntry = {
  entry: AiModelEntry;
  source: AiModelSource;
  /** Config key holding the entry's credential; null for base entries. */
  credentialKey: string | null;
};

/**
 * Layers the owner's list ahead of the system list ahead of the deployment
 * base. An entry is dropped when an earlier layer already carries the same id
 * or the same connection, so a personal copy of a base model wins once.
 */
export function layerAiModelStacks(layers: {
  personal: AiModelStack | null;
  personalKey: string;
  system: AiModelStack | null;
  base: readonly AiModelEntry[];
}): EffectiveAiModelEntry[] {
  const effective: EffectiveAiModelEntry[] = [];
  const admit = (entry: AiModelEntry, source: AiModelSource, credentialKey: string | null) => {
    const id = entry.id.toLowerCase();
    if (effective.some((item) => item.entry.id.toLowerCase() === id || isSameAiModelCredentialScope(item.entry, entry))) {
      return;
    }
    effective.push({ entry, source, credentialKey });
  };
  for (const entry of layers.personal?.models ?? []) {
    admit(entry, "personal", aiModelApiKeyConfigKey(layers.personalKey, entry.id));
  }
  for (const entry of layers.system?.models ?? []) {
    admit(entry, "system", aiModelApiKeyConfigKey(SYSTEM_AI_MODELS_CONFIG_KEY, entry.id));
  }
  for (const entry of layers.base) {
    admit(entry, "base", null);
  }
  return effective;
}

/** Moves the preferred entry to the front; the rest keep their layered order. */
export function orderEffectiveAiModels(
  entries: readonly EffectiveAiModelEntry[],
  preferredModelId: string | null | undefined,
): EffectiveAiModelEntry[] {
  const preferred = preferredModelId?.trim().toLowerCase();
  if (!preferred) {
    return [...entries];
  }
  const index = entries.findIndex((item) => item.entry.id.toLowerCase() === preferred);
  if (index <= 0) {
    return [...entries];
  }
  return [entries[index], ...entries.slice(0, index), ...entries.slice(index + 1)];
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

function normalizeOptionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function normalizeTransportTarget(value: string | undefined): string {
  const normalized = normalizeOptionalText(value);
  return !normalized || normalized === "worker" ? "gsv" : normalized;
}
