import type { ConsoleConfigEntry } from "./consoleModels";
import { z } from "zod";
import { fixedAiProviderModel } from "../../../domain/aiProviders";
import {
  modelDisplayName,
  modelStackDisplayName,
} from "./consoleSettings";

export const DEFAULT_MODEL_LABEL = "GATEWAY DEFAULT";

export type ConsoleModelProfile = {
  id: string;
  name: string;
  values: ConsoleProfileValues;
  createdAt: number;
  updatedAt: number;
};

type ConsoleProfileValues = Record<string, string>;

export type ConsoleModelOption = {
  value: string;
  label: string;
  description?: string;
};

export const MODEL_PROFILE_OPTION_PREFIX = "model-profile:";

const PRIMARY_MODEL_KEY_RE = /^(?:config\/ai|users\/\d+\/ai)\/model$/;
const AGENT_BEHAVIOR_CONFIG_KEY_RE = /^users\/[^/]+\/ai\//i;
const MODEL_PROFILES_KEY_RE = /^(?:config\/ai\/models|users\/(\d+)\/ai\/(?:models|model_profiles))$/;
const SENSITIVE_PROFILE_VALUE_KEY_RE = /(?:^|\/|_)(?:api[_-]?key|password|secret|token|credential)(?:$|\/|_)/i;

const profileScalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const modelProfileSchema = z.object({
  id: profileScalarSchema.optional(),
  name: profileScalarSchema.optional(),
  values: z.record(z.string(), profileScalarSchema).optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
});
const modelProfilesPayloadSchema = z.object({
  profiles: z.array(modelProfileSchema).optional(),
});
const canonicalModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string(),
  model: z.string(),
  baseUrl: z.string().optional(),
  providerStyle: z.string().optional(),
  transportTarget: z.string().optional(),
  maxTokens: z.number().int().positive().optional(),
  contextWindowTokens: z.number().int().positive().optional(),
});
const canonicalModelStackSchema = z.object({
  version: z.literal(1),
  models: z.array(canonicalModelSchema),
});
type ParsedModelProfile = z.infer<typeof modelProfileSchema>;
type ProfileScalar = z.infer<typeof profileScalarSchema>;

function isModelConfigKey(key: string): boolean {
  return PRIMARY_MODEL_KEY_RE.test(key) || MODEL_PROFILES_KEY_RE.test(key);
}

function isModelConfigEntry(entry: ConsoleConfigEntry): boolean {
  return !entry.redacted && entry.value.trim().length > 0 && PRIMARY_MODEL_KEY_RE.test(entry.key);
}

function normalizeModelLabel(value: string): string {
  return value.trim();
}

export function defaultModelLabelForConfig(config: readonly ConsoleConfigEntry[]): string {
  const canonicalSystem = config.find((entry) =>
    !entry.redacted && entry.key === "config/ai/models"
  );
  const canonicalPrimary = canonicalSystem?.value.trim()
    ? parseModelProfiles(canonicalSystem.value)[0]
    : null;
  if (canonicalPrimary) {
    return canonicalPrimary.name;
  }
  const system = config.find((entry) => isModelConfigEntry(entry) && entry.key === "config/ai/model");
  const fallback = system ?? config.find(isModelConfigEntry);
  if (fallback) {
    return normalizeModelLabel(fallback.value);
  }
  return profileModelLabelsForConfig(config)[0] ?? DEFAULT_MODEL_LABEL;
}

export function modelLabelsForConfig(config: readonly ConsoleConfigEntry[]): string[] {
  const defaultLabel = defaultModelLabelForConfig(config);
  const seen = new Set([defaultLabel.toLowerCase()]);
  const labels = [defaultLabel];

  const addLabel = (value: string) => {
    const label = normalizeModelLabel(value);
    const key = label.toLowerCase();
    if (!label || seen.has(key)) {
      return;
    }
    seen.add(key);
    labels.push(label);
  };

  for (const entry of config) {
    if (!isModelConfigEntry(entry)) {
      continue;
    }
    addLabel(entry.value);
  }

  for (const label of profileModelLabelsForConfig(config)) {
    addLabel(label);
  }

  return labels;
}

export function modelOptionsForConfig(config: readonly ConsoleConfigEntry[]): ConsoleModelOption[] {
  const defaultModel = defaultModelLabelForConfig(config);
  const defaultProvider = config.find((entry) =>
    !entry.redacted && entry.key === "config/ai/provider"
  )?.value ?? "";
  const fixedDefaultModel = fixedAiProviderModel(defaultProvider);
  const profileModels = new Set(
    profileModelLabelsForConfig(config).map((model) => model.trim().toLowerCase()).filter(Boolean),
  );
  const options: ConsoleModelOption[] = [];
  const seen = new Map<string, number>();

  const addOption = (value: string, option: Partial<Omit<ConsoleModelOption, "value">> = {}) => {
    const model = normalizeModelLabel(value);
    if (!model) {
      return;
    }
    const key = model.toLowerCase();
    const next = modelOptionForValue(model, option);
    const existingIndex = seen.get(key);
    if (existingIndex === undefined) {
      seen.set(key, options.length);
      options.push(next);
      return;
    }
    const existing = options[existingIndex];
    if (option.label && existing.label === modelDisplayLabel(existing.value)) {
      options[existingIndex] = next;
    } else if (option.description && !existing.description) {
      options[existingIndex] = { ...existing, description: option.description };
    }
  };

  addOption(defaultModel, fixedDefaultModel === defaultModel
    ? {
        label: modelStackDisplayName({
          "config/ai/provider": defaultProvider,
          "config/ai/model": defaultModel,
        }),
        description: "Included and managed by GSV",
      }
    : {});

  for (const entry of config) {
    if (isModelConfigEntry(entry)) {
      const value = entry.value.trim().toLowerCase();
      if (entry.key.startsWith("users/") && profileModels.has(value)) {
        continue;
      }
      addOption(entry.value);
    }
  }

  for (const profile of profileModelOptionsForConfig(config)) {
    addOption(profile.value, {
      label: profile.label,
      description: profile.description,
    });
  }

  return options;
}

function profileModelLabelsForConfig(config: readonly ConsoleConfigEntry[]): string[] {
  return config.flatMap((entry) => {
    if (entry.redacted || !MODEL_PROFILES_KEY_RE.test(entry.key) || !entry.value.trim()) {
      return [];
    }
    return parseModelProfiles(entry.value)
        .filter((profile): profile is ConsoleModelProfile => profile !== null)
        .map((profile) => profile.values["config/ai/model"]?.trim() ?? "")
        .filter(Boolean);
  });
}

function profileModelOptionsForConfig(config: readonly ConsoleConfigEntry[]): ConsoleModelOption[] {
  return config.flatMap((entry) => {
    if (entry.redacted || !MODEL_PROFILES_KEY_RE.test(entry.key) || !entry.value.trim()) {
      return [];
    }
    return parseModelProfiles(entry.value)
        .filter((profile): profile is ConsoleModelProfile => profile !== null)
        .map((profile) => {
          const model = profile.values["config/ai/model"]?.trim() ?? "";
          return model
            ? modelOptionForValue(modelProfileOptionValue(profile.id), {
                label: profile.name,
                description: modelProfileSummary(profile),
              })
            : null;
        })
        .filter((option): option is ConsoleModelOption => option !== null);
  });
}

export function modelProfilesForConfig(
  config: readonly ConsoleConfigEntry[],
  uid: number | null | undefined,
): ConsoleModelProfile[] {
  if (uid === null || uid === undefined || !Number.isFinite(uid)) {
    return [];
  }
  const canonicalEntry = config.find((candidate) =>
    !candidate.redacted && candidate.key === `users/${uid}/ai/models`
  );
  if (canonicalEntry?.value.trim()) {
    return parseModelProfiles(canonicalEntry.value);
  }
  const entry = config.find((candidate) =>
    !candidate.redacted &&
    candidate.key === `users/${uid}/ai/model_profiles`
  );
  if (!entry?.value.trim()) {
    return [];
  }

  return parseModelProfiles(entry.value)
      .filter((profile): profile is ConsoleModelProfile => profile !== null)
      .sort((left, right) => right.updatedAt - left.updatedAt || left.name.localeCompare(right.name));
}

export function modelProfileSummary(profile: ConsoleModelProfile): string {
  const displayName = modelStackDisplayName(profile.values);
  if (fixedAiProviderModel(profile.values["config/ai/provider"] ?? "")) {
    return displayName;
  }
  return [
    profile.values["config/ai/provider"],
    profile.values["config/ai/model"],
  ].map((value) => value?.trim()).filter(Boolean).join(" · ") || "Saved AI config";
}

export function modelProfileOptionValue(profileId: string): string {
  const normalized = normalizeProfileId(profileId);
  return normalized ? `${MODEL_PROFILE_OPTION_PREFIX}${normalized}` : "";
}

export function modelProfileIdFromOptionValue(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized.startsWith(MODEL_PROFILE_OPTION_PREFIX)) {
    return null;
  }
  const profileId = normalizeProfileId(normalized.slice(MODEL_PROFILE_OPTION_PREFIX.length));
  return profileId || null;
}

export function modelConfigEntries(config: readonly ConsoleConfigEntry[]): ConsoleConfigEntry[] {
  return config.filter(isModelConfigEntry);
}

export function modelConfigCount(config: readonly ConsoleConfigEntry[]): number {
  const stacked = config.reduce((count, entry) =>
    entry.redacted || !MODEL_PROFILES_KEY_RE.test(entry.key)
      ? count
      : count + parseModelProfiles(entry.value).length, 0);
  return stacked || modelConfigEntries(config).length;
}

export function overrideConfigEntries(config: readonly ConsoleConfigEntry[]): ConsoleConfigEntry[] {
  return config.filter((entry) => !isModelConfigKey(entry.key) && !AGENT_BEHAVIOR_CONFIG_KEY_RE.test(entry.key));
}

export function overrideConfigCount(config: readonly ConsoleConfigEntry[]): number {
  return overrideConfigEntries(config).length;
}

function parseModelProfiles(rawValue: string): ConsoleModelProfile[] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(rawValue);
  } catch {
    return [];
  }
  const canonical = canonicalModelStackSchema.safeParse(decoded);
  if (canonical.success) {
    return canonical.data.models.map((model) => ({
      id: normalizeProfileId(model.id),
      name: normalizeProfileName(model.name),
      values: {
        "config/ai/provider": model.provider,
        "config/ai/model": model.model,
        ...(model.baseUrl ? { "config/ai/base_url": model.baseUrl } : undefined),
        ...(model.providerStyle ? { "config/ai/provider_style": model.providerStyle } : undefined),
        ...(model.transportTarget ? { "config/ai/transport_target": model.transportTarget } : undefined),
        ...(model.maxTokens !== undefined ? { "config/ai/max_tokens": String(model.maxTokens) } : undefined),
        ...(model.contextWindowTokens !== undefined
          ? { "config/ai/context_window_tokens": String(model.contextWindowTokens) }
          : undefined),
      },
      createdAt: 0,
      updatedAt: 0,
    })).filter((profile) => profile.id && profile.name);
  }
  const parsed = modelProfilesPayloadSchema.safeParse(decoded);
  if (!parsed.success) {
    return [];
  }
  return (parsed.data.profiles ?? [])
    .map(normalizeModelProfile)
    .filter((profile): profile is ConsoleModelProfile => profile !== null);
}

function normalizeModelProfile(value: ParsedModelProfile): ConsoleModelProfile | null {
  const id = normalizeProfileId(value.id);
  const name = normalizeProfileName(value.name);
  if (!id || !name) {
    return null;
  }
  const values = normalizeProfileValues(value.values ?? {});
  return {
    id,
    name,
    values,
    createdAt: normalizeTimestamp(value.createdAt),
    updatedAt: normalizeTimestamp(value.updatedAt),
  };
}

function normalizeProfileValues(value: Record<string, ProfileScalar>) {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key.startsWith("config/ai/") && !SENSITIVE_PROFILE_VALUE_KEY_RE.test(key))
      .map(([key, rawValue]) => [key, String(rawValue ?? "")]),
  );
}

function normalizeProfileName(value: ProfileScalar | undefined): string {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, 80);
}

function normalizeProfileId(value: ProfileScalar | undefined): string {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

function normalizeTimestamp(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;
}

export function modelOptionForValue(
  value: string,
  option: Partial<Omit<ConsoleModelOption, "value">> = {},
): ConsoleModelOption {
  const model = normalizeModelLabel(value);
  return {
    value: model,
    label: normalizeModelOptionLabel(option.label) || modelDisplayLabel(model),
    description: normalizeModelOptionLabel(option.description) || modelOptionDescription(model),
  };
}

function modelDisplayLabel(value: string): string {
  return modelDisplayName(value) || value;
}

function modelOptionDescription(value: string): string | undefined {
  const display = modelDisplayLabel(value);
  return display && display !== value ? value : undefined;
}

function normalizeModelOptionLabel(value: string | undefined): string {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}
