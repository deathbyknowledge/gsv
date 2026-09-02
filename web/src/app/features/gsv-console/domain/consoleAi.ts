import type { ConsoleConfigEntry } from "./consoleModels";
import {
  modelDisplayName,
  modelProfilesForConfig as modelStackForConfig,
  modelStackDisplayName,
  type ConsoleModelProfile,
} from "./consoleSettings";

export const DEFAULT_MODEL_LABEL = "NOT CONFIGURED";

export type { ConsoleModelProfile } from "./consoleSettings";

export type ConsoleModelOption = {
  value: string;
  label: string;
  description?: string;
};

export const MODEL_ENTRY_OPTION_PREFIX = "model-entry:";

const MODEL_STACK_KEY_RE = /^(?:config\/ai\/models|users\/\d+\/ai\/models)$/;
const MODEL_STACK_PATH_RE = /^(?:config\/ai\/models|users\/\d+\/ai\/models)(?:\/|$)/;
const AGENT_BEHAVIOR_CONFIG_KEY_RE = /^users\/[^/]+\/ai\//i;

function effectiveModelProfiles(
  config: readonly ConsoleConfigEntry[],
  uid?: number | null,
): ConsoleModelProfile[] {
  const modelOwnerUid = uid !== null && uid !== undefined && Number.isFinite(uid)
    ? uid
    : 0;
  return modelStackForConfig(config, modelOwnerUid, {
    inheritSystem: modelOwnerUid !== 0,
  });
}

export function defaultModelLabelForConfig(
  config: readonly ConsoleConfigEntry[],
  uid?: number | null,
): string {
  return effectiveModelProfiles(config, uid)[0]?.name ?? DEFAULT_MODEL_LABEL;
}

export function modelLabelsForConfig(
  config: readonly ConsoleConfigEntry[],
  uid?: number | null,
): string[] {
  return effectiveModelProfiles(config, uid).map((profile) => profile.name);
}

export function modelOptionsForConfig(
  config: readonly ConsoleConfigEntry[],
  uid?: number | null,
): ConsoleModelOption[] {
  return effectiveModelProfiles(config, uid).map((profile) => ({
    value: modelEntryOptionValue(profile.id),
    label: profile.name,
    description: modelProfileSummary(profile),
  }));
}

export function modelProfilesForConfig(
  config: readonly ConsoleConfigEntry[],
  uid: number | null | undefined,
): ConsoleModelProfile[] {
  return effectiveModelProfiles(config, uid);
}

export function modelProfileSummary(profile: ConsoleModelProfile): string {
  return modelStackDisplayName(profile.values)
    || modelDisplayName(profile.values["config/ai/model"] ?? "")
    || "Saved model configuration";
}

export function modelEntryOptionValue(modelId: string): string {
  const normalized = normalizeProfileId(modelId);
  return normalized ? `${MODEL_ENTRY_OPTION_PREFIX}${normalized}` : "";
}

export function modelEntryIdFromOptionValue(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized.startsWith(MODEL_ENTRY_OPTION_PREFIX)) {
    return null;
  }
  const modelId = normalizeProfileId(normalized.slice(MODEL_ENTRY_OPTION_PREFIX.length));
  return modelId || null;
}

export function modelConfigEntries(config: readonly ConsoleConfigEntry[]): ConsoleConfigEntry[] {
  return config.filter((entry) =>
    !entry.redacted && entry.value.trim().length > 0 && MODEL_STACK_KEY_RE.test(entry.key)
  );
}

export function modelConfigCount(config: readonly ConsoleConfigEntry[]): number {
  return modelConfigEntries(config).reduce((count, entry) => {
    const uidMatch = /^users\/(\d+)\/ai\/models$/.exec(entry.key);
    const uid = uidMatch ? Number(uidMatch[1]) : 0;
    return count + modelStackForConfig([entry], uid).length;
  }, 0);
}

export function overrideConfigEntries(config: readonly ConsoleConfigEntry[]): ConsoleConfigEntry[] {
  return config.filter((entry) =>
    !MODEL_STACK_PATH_RE.test(entry.key) && !AGENT_BEHAVIOR_CONFIG_KEY_RE.test(entry.key)
  );
}

export function overrideConfigCount(config: readonly ConsoleConfigEntry[]): number {
  return overrideConfigEntries(config).length;
}

export function modelOptionForValue(
  value: string,
  option: Partial<Omit<ConsoleModelOption, "value">> = {},
): ConsoleModelOption {
  const model = value.trim();
  return {
    value: model,
    label: normalizeModelOptionLabel(option.label) || modelDisplayLabel(model),
    description: normalizeModelOptionLabel(option.description) || modelOptionDescription(model),
  };
}

function normalizeProfileId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

function modelDisplayLabel(value: string): string {
  return modelDisplayName(value) || value;
}

function modelOptionDescription(value: string): string | undefined {
  const display = modelDisplayLabel(value);
  return display && display !== value ? value : undefined;
}

function normalizeModelOptionLabel(value: string | undefined): string {
  return value?.trim() ?? "";
}
