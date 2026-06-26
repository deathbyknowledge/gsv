import type { ConsoleConfigEntry } from "./consoleModels";

export const DEFAULT_MODEL_LABEL = "GATEWAY DEFAULT";

export type ConsoleModelProfile = {
  id: string;
  name: string;
  values: Record<string, string>;
  createdAt: number;
  updatedAt: number;
};

const MODEL_CONFIG_KEY_RE = /(^|[/.])model($|[/.])|default.*model|model.*default/i;
const PRIMARY_MODEL_KEY_RE = /(^|[/.])ai[/.]model$|default.*model|model.*default/i;
const AGENT_BEHAVIOR_CONFIG_KEY_RE = /^users\/[^/]+\/ai\//i;
const MODEL_PROFILES_KEY_RE = /^users\/(\d+)\/ai\/model_profiles$/;
const SENSITIVE_PROFILE_VALUE_KEY_RE = /(?:^|\/|_)(?:api[_-]?key|password|secret|token|credential)(?:$|\/|_)/i;

function isModelConfigKey(key: string): boolean {
  return MODEL_CONFIG_KEY_RE.test(key);
}

function isModelConfigEntry(entry: ConsoleConfigEntry): boolean {
  return !entry.redacted && entry.value.trim().length > 0 && isModelConfigKey(entry.key);
}

function normalizeModelLabel(value: string): string {
  return value.trim();
}

export function defaultModelLabelForConfig(config: readonly ConsoleConfigEntry[]): string {
  const primary = config.find((entry) => isModelConfigEntry(entry) && PRIMARY_MODEL_KEY_RE.test(entry.key));
  const fallback = primary ?? config.find(isModelConfigEntry);
  return fallback ? normalizeModelLabel(fallback.value) : DEFAULT_MODEL_LABEL;
}

export function modelLabelsForConfig(config: readonly ConsoleConfigEntry[]): string[] {
  const defaultLabel = defaultModelLabelForConfig(config);
  const seen = new Set([defaultLabel.toLowerCase()]);
  const labels = [defaultLabel];

  for (const entry of config) {
    if (!isModelConfigEntry(entry)) {
      continue;
    }
    const label = normalizeModelLabel(entry.value);
    const key = label.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    labels.push(label);
  }

  return labels;
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
