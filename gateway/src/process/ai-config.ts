import type {
  ProcAiConfigProfileRef,
  ProcAiConfigSnapshot,
} from "../syscalls/proc";

export const PROCESS_AI_CONFIG_STORE_KEY = "aiConfigSnapshot";
export const PROCESS_AI_CONFIG_KEY_PREFIX = "config/ai/";

export const PROCESS_AI_CONFIG_KEYS = [
  "config/ai/provider",
  "config/ai/model",
  "config/ai/api_key",
  "config/ai/reasoning",
  "config/ai/max_tokens",
  "config/ai/context_window_tokens",
  "config/ai/max_context_bytes",
  "config/ai/generation/timeout_ms",
  "config/ai/generation/streaming",
  "config/ai/image/read/provider",
  "config/ai/image/read/model",
  "config/ai/image/read/api_key",
  "config/ai/image/read/input_format",
  "config/ai/image/read/max_bytes",
  "config/ai/image/read/max_tokens",
  "config/ai/image/read/timeout_ms",
  "config/ai/image/read/prompt",
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

export const PROCESS_AI_CONFIG_SECRET_KEYS = new Set<string>(
  PROCESS_AI_CONFIG_KEYS.filter((key) => key === "config/ai/api_key" || key.endsWith("/api_key")),
);

const PROCESS_AI_ROOT_FILES = [
  "effective.json",
  "local.json",
  "profile",
  "profiles",
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
  if (!suffix || PROCESS_AI_ROOT_FILES.includes(suffix as typeof PROCESS_AI_ROOT_FILES[number])) {
    return null;
  }
  const key = `${PROCESS_AI_CONFIG_KEY_PREFIX}${suffix}`;
  return isProcessAiConfigKey(key) ? key : null;
}

export function processAiConfigDirEntries(parts: string[] = []): string[] {
  const prefix = parts.filter(Boolean).join("/");
  const prefixWithSlash = prefix ? `${prefix}/` : "";
  const entries = new Set<string>();

  if (!prefix) {
    for (const entry of PROCESS_AI_ROOT_FILES) {
      entries.add(entry);
    }
  }

  for (const key of PROCESS_AI_CONFIG_KEYS) {
    const suffix = processAiConfigSuffix(key);
    if (prefix && !suffix.startsWith(prefixWithSlash)) {
      continue;
    }
    const rest = prefix ? suffix.slice(prefixWithSlash.length) : suffix;
    const child = rest.split("/")[0];
    if (child) {
      entries.add(child);
    }
  }

  return [...entries].sort();
}

export function normalizeProcessAiConfigValues(raw: Record<string, unknown>): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isProcessAiConfigKey(key)) {
      continue;
    }
    values[key] = String(value ?? "");
  }
  return values;
}

export function createProcessAiConfigSnapshot(
  values: Record<string, unknown>,
  profile?: { id?: unknown; name?: unknown },
  now = Date.now(),
): ProcAiConfigSnapshot {
  const snapshot: ProcAiConfigSnapshot = {
    version: 1,
    values: normalizeProcessAiConfigValues(values),
    updatedAt: now,
  };
  const profileRef = normalizeProfileRef(profile, now);
  if (profileRef) {
    snapshot.profile = profileRef;
  }
  return snapshot;
}

export function normalizeProcessAiConfigSnapshot(raw: unknown): ProcAiConfigSnapshot | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const values = record.values && typeof record.values === "object" && !Array.isArray(record.values)
    ? normalizeProcessAiConfigValues(record.values as Record<string, unknown>)
    : {};
  const updatedAt = typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt) && record.updatedAt > 0
    ? record.updatedAt
    : Date.now();
  const snapshot: ProcAiConfigSnapshot = {
    version: 1,
    values,
    updatedAt,
  };
  const profile = normalizeProfileRef(record.profile, updatedAt);
  if (profile) {
    snapshot.profile = profile;
  }
  return snapshot;
}

export function redactProcessAiConfigSnapshot(snapshot: ProcAiConfigSnapshot | null): ProcAiConfigSnapshot | null {
  if (!snapshot) {
    return null;
  }
  return {
    ...snapshot,
    values: redactProcessAiConfigValues(snapshot.values),
  };
}

export function redactProcessAiConfigValues(values: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    redacted[key] = redactProcessAiConfigValue(key, value);
  }
  return redacted;
}

export function redactProcessAiConfigValue(key: string, value: string | null | undefined): string {
  if (!value) {
    return "";
  }
  return PROCESS_AI_CONFIG_SECRET_KEYS.has(key) ? "redacted" : value;
}

function normalizeProfileRef(raw: unknown, fallbackAppliedAt: number): ProcAiConfigProfileRef | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const id = normalizeOptionalText(record.id);
  const name = normalizeOptionalText(record.name);
  if (!id && !name) {
    return null;
  }
  const appliedAt = typeof record.appliedAt === "number" && Number.isFinite(record.appliedAt) && record.appliedAt > 0
    ? record.appliedAt
    : fallbackAppliedAt;
  return {
    ...(id ? { id } : {}),
    ...(name ? { name } : {}),
    appliedAt,
  };
}

function normalizeOptionalText(value: unknown): string | undefined {
  const normalized = String(value ?? "").trim();
  return normalized.length > 0 ? normalized : undefined;
}
