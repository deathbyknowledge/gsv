import type { ConsoleConfigEntry } from "./consoleModels";
import { modelDisplayName } from "./consoleSettings";

export const DEFAULT_MODEL_LABEL = "GATEWAY DEFAULT";

export type ConsoleModelProfile = {
  id: string;
  name: string;
  values: Record<string, string>;
  createdAt: number;
  updatedAt: number;
};

export type ConsoleModelOption = {
  value: string;
  label: string;
  description?: string;
};

export const MODEL_PROFILE_OPTION_PREFIX = "model-profile:";

const PRIMARY_MODEL_KEY_RE = /^(?:config\/ai|users\/\d+\/ai)\/model$/;
const AGENT_BEHAVIOR_CONFIG_KEY_RE = /^users\/[^/]+\/ai\//i;
const MODEL_PROFILES_KEY_RE = /^users\/(\d+)\/ai\/model_profiles$/;
const SENSITIVE_PROFILE_VALUE_KEY_RE = /(?:^|\/|_)(?:api[_-]?key|password|secret|token|credential)(?:$|\/|_)/i;

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

  addOption(defaultModel);

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
    try {
      const payload = JSON.parse(entry.value) as { profiles?: unknown[] };
      const profiles = Array.isArray(payload.profiles) ? payload.profiles : [];
      return profiles
        .map(normalizeModelProfile)
        .filter((profile): profile is ConsoleModelProfile => profile !== null)
        .map((profile) => profile.values["config/ai/model"]?.trim() ?? "")
        .filter(Boolean);
    } catch {
      return [];
    }
  });
}

function profileModelOptionsForConfig(config: readonly ConsoleConfigEntry[]): ConsoleModelOption[] {
  return config.flatMap((entry) => {
    if (entry.redacted || !MODEL_PROFILES_KEY_RE.test(entry.key) || !entry.value.trim()) {
      return [];
    }
    try {
      const payload = JSON.parse(entry.value) as { profiles?: unknown[] };
      const profiles = Array.isArray(payload.profiles) ? payload.profiles : [];
      return profiles
        .map(normalizeModelProfile)
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
    } catch {
      return [];
    }
  });
}

export function modelProfilesForConfig(
  config: readonly ConsoleConfigEntry[],
  uid: number | null | undefined,
): ConsoleModelProfile[] {
  if (typeof uid !== "number" || !Number.isFinite(uid)) {
    return [];
  }
  const entry = config.find((candidate) =>
    !candidate.redacted &&
    MODEL_PROFILES_KEY_RE.test(candidate.key) &&
    candidate.key === `users/${uid}/ai/model_profiles`
  );
  if (!entry?.value.trim()) {
    return [];
  }

  try {
    const payload = JSON.parse(entry.value) as { profiles?: unknown[] };
    const profiles = Array.isArray(payload.profiles) ? payload.profiles : [];
    return profiles
      .map(normalizeModelProfile)
      .filter((profile): profile is ConsoleModelProfile => profile !== null)
      .sort((left, right) => right.updatedAt - left.updatedAt || left.name.localeCompare(right.name));
  } catch {
    return [];
  }
}

export function modelProfileSummary(profile: ConsoleModelProfile): string {
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
  return modelConfigEntries(config).length;
}

export function overrideConfigEntries(config: readonly ConsoleConfigEntry[]): ConsoleConfigEntry[] {
  return config.filter((entry) => !isModelConfigKey(entry.key) && !AGENT_BEHAVIOR_CONFIG_KEY_RE.test(entry.key));
}

export function overrideConfigCount(config: readonly ConsoleConfigEntry[]): number {
  return overrideConfigEntries(config).length;
}

function normalizeModelProfile(value: unknown): ConsoleModelProfile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = normalizeProfileId(record.id);
  const name = normalizeProfileName(record.name);
  if (!id || !name) {
    return null;
  }
  const values = normalizeProfileValues(record.values);
  return {
    id,
    name,
    values,
    createdAt: normalizeTimestamp(record.createdAt),
    updatedAt: normalizeTimestamp(record.updatedAt),
  };
}

function normalizeProfileValues(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const values: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value as Record<string, unknown>)) {
    if (key.startsWith("config/ai/") && !SENSITIVE_PROFILE_VALUE_KEY_RE.test(key)) {
      values[key] = String(rawValue ?? "");
    }
  }
  return values;
}

function normalizeProfileName(value: unknown): string {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, 80);
}

function normalizeProfileId(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

function normalizeTimestamp(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
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
