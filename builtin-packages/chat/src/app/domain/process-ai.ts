import type {
  ContextState,
  ProcessAiEffectiveState,
  ProcessAiModelProfile,
  ProcessAiProfileRef,
  ProcessAiSnapshot,
  ProcessAiState,
} from "../types";

export const CHAT_PROVIDER_KEY = "config/ai/provider";
export const CHAT_MODEL_KEY = "config/ai/model";
export const CHAT_REASONING_KEY = "config/ai/reasoning";

export const PROCESS_AI_REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export type ProcessAiReasoningLevel = typeof PROCESS_AI_REASONING_LEVELS[number];

export function normalizeProcessAiState(value: unknown): ProcessAiState | null {
  const record = asRecord(value);
  if (!record || record.ok !== true) {
    return null;
  }
  const effective = normalizeEffectiveState(record.effective);
  if (!effective) {
    return null;
  }
  return {
    profile: normalizeText(record.profile),
    effective,
    local: normalizeSnapshot(record.local),
    profiles: normalizeProfiles(record.profiles),
  };
}

export function processAiModelLabel(state: ProcessAiState | null, contextState: ContextState | null): string {
  const model = processAiValue(state, CHAT_MODEL_KEY) || contextState?.model || "";
  return shortModelName(model) || "AI model";
}

export function processAiProviderLabel(state: ProcessAiState | null, contextState: ContextState | null): string {
  return processAiValue(state, CHAT_PROVIDER_KEY) || contextState?.provider || "provider";
}

export function processAiReasoningLabel(state: ProcessAiState | null): string {
  const value = processAiValue(state, CHAT_REASONING_KEY) || "medium";
  return value.trim() || "medium";
}

export function processAiReasoningIsActive(state: ProcessAiState | null, level: ProcessAiReasoningLevel): boolean {
  return processAiReasoningLabel(state).toLowerCase() === level;
}

export function processAiValue(state: ProcessAiState | null, key: string): string {
  return normalizeText(state?.effective.values[key]);
}

export function processAiHasLocalOverride(state: ProcessAiState | null): boolean {
  return Boolean(state?.local?.profile || Object.keys(state?.local?.values ?? {}).length > 0);
}

export function processAiActiveProfileRef(state: ProcessAiState | null): ProcessAiProfileRef | null {
  return state?.local?.profile ?? state?.effective.profile ?? null;
}

export function processAiProfileIsActive(state: ProcessAiState | null, profile: ProcessAiModelProfile): boolean {
  const active = processAiActiveProfileRef(state);
  if (!active) {
    return false;
  }
  const activeId = normalizeText(active.id).toLowerCase();
  const activeName = normalizeText(active.name).toLowerCase();
  return Boolean(
    activeId && activeId === profile.id.toLowerCase()
    || activeName && activeName === profile.name.toLowerCase(),
  );
}

export function processAiProfileSummary(profile: ProcessAiModelProfile): string {
  const provider = normalizeText(profile.values[CHAT_PROVIDER_KEY]) || "provider";
  const model = shortModelName(profile.values[CHAT_MODEL_KEY]) || "model";
  const image = shortModelName(profile.values["config/ai/image/read/model"]);
  const speech = shortModelName(profile.values["config/ai/speech/model"]);
  const extras = [image ? `image ${image}` : "", speech ? `speech ${speech}` : ""].filter(Boolean);
  return [`${provider}/${model}`, ...extras].join(" - ");
}

export function shortModelName(value: unknown): string {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "";
  }
  if (normalized.startsWith("@cf/")) {
    const parts = normalized.split("/").filter(Boolean);
    return parts[parts.length - 1] || normalized;
  }
  return normalized;
}

function normalizeEffectiveState(value: unknown): ProcessAiEffectiveState | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  return {
    profile: normalizeProfileRef(record.profile),
    values: normalizeValues(record.values),
  };
}

function normalizeSnapshot(value: unknown): ProcessAiSnapshot | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  return {
    version: normalizeNumber(record.version),
    profile: normalizeProfileRef(record.profile),
    values: normalizeValues(record.values),
    updatedAt: normalizeNumber(record.updatedAt),
  };
}

function normalizeProfiles(value: unknown): ProcessAiModelProfile[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(normalizeProfile)
    .filter((profile): profile is ProcessAiModelProfile => profile !== null);
}

function normalizeProfile(value: unknown): ProcessAiModelProfile | null {
  const record = asRecord(value);
  const id = normalizeText(record?.id);
  const name = normalizeText(record?.name);
  if (!record || !id || !name) {
    return null;
  }
  return {
    id,
    name,
    values: normalizeValues(record.values),
    createdAt: normalizeNumber(record.createdAt) ?? Date.now(),
    updatedAt: normalizeNumber(record.updatedAt) ?? Date.now(),
  };
}

function normalizeProfileRef(value: unknown): ProcessAiProfileRef | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const id = normalizeText(record.id);
  const name = normalizeText(record.name);
  if (!id && !name) {
    return null;
  }
  const appliedAt = normalizeNumber(record.appliedAt);
  return {
    ...(id ? { id } : {}),
    ...(name ? { name } : {}),
    ...(appliedAt ? { appliedAt } : {}),
  };
}

function normalizeValues(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (!record) {
    return {};
  }
  const values: Record<string, string> = {};
  for (const [key, raw] of Object.entries(record)) {
    values[key] = normalizeText(raw);
  }
  return values;
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
