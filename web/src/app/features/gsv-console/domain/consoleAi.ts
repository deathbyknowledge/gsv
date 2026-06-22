import type { ConsoleConfigEntry } from "./consoleModels";

export const DEFAULT_MODEL_LABEL = "GATEWAY DEFAULT";

const MODEL_CONFIG_KEY_RE = /(^|[/.])model($|[/.])|default.*model|model.*default/i;
const PRIMARY_MODEL_KEY_RE = /(^|[/.])ai[/.]model$|default.*model|model.*default/i;
const AGENT_BEHAVIOR_CONFIG_KEY_RE = /^users\/[^/]+\/ai\//i;

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
