import type {
  JsonValue,
  ProcAiConfig,
} from "@humansandmachines/gsv/protocol";
import { z } from "zod";

export const PROCESS_AI_CONFIG_STORE_KEY = "aiConfig";
export const LEGACY_PROCESS_AI_CONFIG_STORE_KEY = "aiConfigSnapshot";
export const PROCESS_AI_CONFIG_KEY_PREFIX = "config/ai/";

export const PROCESS_AI_CONFIG_KEYS = [
  "config/ai/provider",
  "config/ai/model",
  "config/ai/base_url",
  "config/ai/provider_style",
  "config/ai/transport_target",
  "config/ai/fallback_model_profile",
  "config/ai/api_key",
  "config/ai/reasoning",
  "config/ai/max_tokens",
  "config/ai/context_window_tokens",
  "config/ai/max_context_bytes",
  "config/ai/generation/timeout_ms",
  "config/ai/generation/streaming",
  "config/ai/image/read/max_bytes",
  "config/ai/image/read/max_tokens",
  "config/ai/image/read/max_objects",
  "config/ai/image/read/timeout_ms",
  "config/ai/image/generation/provider",
  "config/ai/image/generation/model",
  "config/ai/image/generation/api_key",
  "config/ai/transcription/provider",
  "config/ai/transcription/model",
  "config/ai/transcription/api_key",
  "config/ai/transcription/max_bytes",
  "config/ai/speech/provider",
  "config/ai/speech/model",
  "config/ai/speech/api_key",
  "config/ai/speech/speaker",
  "config/ai/speech/encoding",
  "config/ai/speech/max_chars",
  "config/ai/speech/timeout_ms",
] as const;

const PROCESS_AI_CONFIG_KEY_SET = new Set<string>(PROCESS_AI_CONFIG_KEYS);
const PROCESS_AI_MODEL_PROFILE_EXCLUDED_KEYS = new Set<string>([
  "config/ai/fallback_model_profile",
]);

export const PROCESS_AI_CONFIG_SECRET_KEYS = new Set<string>(
  PROCESS_AI_CONFIG_KEYS.filter((key) => key === "config/ai/api_key" || key.endsWith("/api_key")),
);

export type ProcessAiModelProfile = {
  id: string;
  name: string;
  values: Record<string, string>;
  createdAt: number;
  updatedAt: number;
};

interface ProcessAiConfigValues {
  [key: string]: string;
}

const positiveTimestampSchema = z.number().finite().positive();
const processAiJsonValueSchema: z.ZodType<JsonValue> = z.json();
const processAiJsonObjectSchema = z.record(z.string(), processAiJsonValueSchema);
const storedProcessAiConfigSchema = z.object({
  version: z.literal(2),
  modelId: processAiJsonValueSchema.optional(),
  reasoning: processAiJsonValueSchema.optional(),
  updatedAt: positiveTimestampSchema.optional().catch(undefined),
}).passthrough();
const legacyProcessAiConfigSnapshotSchema = z.object({
  values: processAiJsonObjectSchema.optional().catch(undefined),
  updatedAt: positiveTimestampSchema.optional().catch(undefined),
  profile: z.object({
    id: processAiJsonValueSchema.optional(),
    name: processAiJsonValueSchema.optional(),
    appliedAt: processAiJsonValueSchema.optional(),
  }).optional().catch(undefined),
}).passthrough();
const storedProcessAiModelProfileSchema = z.object({
  id: processAiJsonValueSchema.optional(),
  name: processAiJsonValueSchema.optional(),
  values: processAiJsonObjectSchema.optional().catch(undefined),
  createdAt: processAiJsonValueSchema.optional(),
  updatedAt: processAiJsonValueSchema.optional(),
}).passthrough();
const storedProcessAiModelProfilesSchema = z.object({
  profiles: z.array(processAiJsonValueSchema).optional().catch(undefined),
}).passthrough();

const PROCESS_AI_ROOT_FILES = [
  "effective.json",
  "local.json",
  "model",
  "models",
  "reasoning",
] as const;

export function isProcessAiConfigKey(key: string): boolean {
  return PROCESS_AI_CONFIG_KEY_SET.has(key);
}

export function processAiConfigSuffix(key: string): string {
  return key.startsWith(PROCESS_AI_CONFIG_KEY_PREFIX)
    ? key.slice(PROCESS_AI_CONFIG_KEY_PREFIX.length)
    : key;
}

export function processAiPathToConfigKey(parts: string[]): string | null {
  const suffix = parts.filter(Boolean).join("/");
  if (!suffix || PROCESS_AI_ROOT_FILES.some((rootFile) => rootFile === suffix)) {
    return null;
  }
  const key = `${PROCESS_AI_CONFIG_KEY_PREFIX}${suffix}`;
  return isProcessAiConfigKey(key) ? key : null;
}

export function processAiConfigDirEntries(parts: string[] = []): string[] {
  return parts.filter(Boolean).length === 0 ? [...PROCESS_AI_ROOT_FILES].sort() : [];
}

export function normalizeProcessAiConfigValues(
  raw: Readonly<Record<string, JsonValue>>,
): ProcessAiConfigValues {
  const values: ProcessAiConfigValues = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isProcessAiConfigKey(key)) {
      continue;
    }
    const normalized = String(value ?? "").trim();
    if (!normalized) {
      continue;
    }
    values[key] = normalized;
  }
  return values;
}

export function createProcessAiConfig(
  input: { modelId?: string | null; reasoning?: string | null },
  now = Date.now(),
): ProcAiConfig | null {
  const modelId = normalizeProcessAiModelId(input.modelId);
  const reasoning = normalizeProcessAiReasoning(input.reasoning);
  if (!modelId && !reasoning) {
    return null;
  }
  const config: ProcAiConfig = {
    version: 2,
    updatedAt: now,
  };
  if (modelId) config.modelId = modelId;
  if (reasoning) config.reasoning = reasoning;
  return config;
}

export function parseProcessAiConfig(raw: string): ProcAiConfig | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const current = storedProcessAiConfigSchema.safeParse(value);
  if (current.success) {
    return createProcessAiConfig({
      modelId: normalizeOptionalText(current.data.modelId),
      reasoning: normalizeOptionalText(current.data.reasoning),
    }, current.data.updatedAt ?? Date.now());
  }
  const legacy = legacyProcessAiConfigSnapshotSchema.safeParse(value);
  if (!legacy.success) {
    return null;
  }
  return createProcessAiConfig({
    modelId: normalizeOptionalText(legacy.data.profile?.id),
    reasoning: normalizeOptionalText(legacy.data.values?.["config/ai/reasoning"]),
  }, legacy.data.updatedAt ?? Date.now());
}

export function redactProcessAiConfigValues(values: ProcessAiConfigValues): ProcessAiConfigValues {
  const redacted: ProcessAiConfigValues = {};
  for (const [key, value] of Object.entries(values)) {
    redacted[key] = redactProcessAiConfigValue(key, value);
  }
  return redacted;
}

export function omitProcessAiConfigSecrets(values: ProcessAiConfigValues): ProcessAiConfigValues {
  const visible: ProcessAiConfigValues = {};
  for (const [key, value] of Object.entries(values)) {
    if (!PROCESS_AI_CONFIG_SECRET_KEYS.has(key)) {
      visible[key] = value;
    }
  }
  return visible;
}

export function redactProcessAiConfigValue(key: string, value: string | null | undefined): string {
  if (!value) {
    return "";
  }
  return PROCESS_AI_CONFIG_SECRET_KEYS.has(key) ? "redacted" : value;
}

export function normalizeProcessAiModelId(value: string | null | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized && /^[a-z0-9][a-z0-9_-]{0,79}$/.test(normalized)
    ? normalized
    : undefined;
}

export function normalizeProcessAiReasoning(value: string | null | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized === "off" ||
      normalized === "minimal" ||
      normalized === "low" ||
      normalized === "medium" ||
      normalized === "high" ||
      normalized === "xhigh"
    ? normalized
    : undefined;
}

function normalizeOptionalText(value: JsonValue | undefined): string | undefined {
  const normalized = String(value ?? "").trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function parseProcessAiModelProfiles(
  raw: string | null | undefined,
  ownerUid: number,
  getConfigValue?: (key: string) => string | null,
): ProcessAiModelProfile[] {
  if (!raw) {
    return [];
  }

  try {
    const payload = storedProcessAiModelProfilesSchema.safeParse(JSON.parse(raw));
    if (!payload.success) {
      return [];
    }
    return (payload.data.profiles ?? [])
      .map(normalizeProcessAiModelProfile)
      .filter((profile): profile is ProcessAiModelProfile => profile !== null)
      .map((profile) => getConfigValue
        ? hydrateProcessAiModelProfileSecrets(ownerUid, profile, getConfigValue)
        : profile)
      .sort((left, right) => right.updatedAt - left.updatedAt || left.name.localeCompare(right.name));
  } catch {
    return [];
  }
}

export function findProcessAiModelProfile(
  raw: string | null | undefined,
  ownerUid: number,
  selector: string,
  getConfigValue?: (key: string) => string | null,
): ProcessAiModelProfile | null {
  const normalized = selector.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  return parseProcessAiModelProfiles(raw, ownerUid, getConfigValue).find((profile) =>
    profile.id.toLowerCase() === normalized ||
    profile.name.toLowerCase() === normalized
  ) ?? null;
}

export function processAiModelProfileSecretConfigKey(
  ownerUid: number,
  profileId: string,
  configKey: string,
): string {
  return `users/${ownerUid}/ai/model_profiles/${profileId}/${processAiConfigSuffix(configKey)}`;
}

function normalizeProcessAiModelProfile(raw: JsonValue): ProcessAiModelProfile | null {
  const parsed = storedProcessAiModelProfileSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  const id = normalizeProfileText(parsed.data.id).toLowerCase().replace(/[^a-z0-9_-]/g, "");
  const name = normalizeProfileText(parsed.data.name);
  if (!id || !name) {
    return null;
  }
  return {
    id,
    name,
    values: parsed.data.values
      ? normalizeProcessAiModelProfileValues(parsed.data.values)
      : {},
    createdAt: normalizeProfileTimestamp(parsed.data.createdAt),
    updatedAt: normalizeProfileTimestamp(parsed.data.updatedAt),
  };
}

function normalizeProcessAiModelProfileValues(
  raw: Readonly<Record<string, JsonValue>>,
): ProcessAiConfigValues {
  const values = normalizeProcessAiConfigValues(raw);
  for (const key of PROCESS_AI_MODEL_PROFILE_EXCLUDED_KEYS) {
    delete values[key];
  }
  return values;
}

function hydrateProcessAiModelProfileSecrets(
  ownerUid: number,
  profile: ProcessAiModelProfile,
  getConfigValue: (key: string) => string | null,
): ProcessAiModelProfile {
  const values = { ...profile.values };
  for (const key of PROCESS_AI_CONFIG_SECRET_KEYS) {
    const value = getConfigValue(processAiModelProfileSecretConfigKey(ownerUid, profile.id, key));
    if (value) {
      values[key] = value;
    }
  }
  return { ...profile, values };
}

function normalizeProfileText(value: JsonValue | undefined): string {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function normalizeProfileTimestamp(value: JsonValue | undefined): number {
  const timestamp = positiveTimestampSchema.safeParse(value);
  return timestamp.success ? timestamp.data : 0;
}
