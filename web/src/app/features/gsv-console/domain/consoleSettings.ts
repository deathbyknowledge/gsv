import type { AiModelListEntry, AiModelSource, AiModelsResult } from "@humansandmachines/gsv/protocol";
import type { ConsoleAccount, ConsoleConfigEntry } from "./consoleModels";
import {
  AI_OPENAI_WORKERS_PROVIDER_OPTIONS,
  AI_PROVIDER_OPTIONS,
  aiProviderDisplayLabel,
  fixedAiProviderModel,
} from "../../../domain/aiProviders";
import { z } from "zod";

const settingsValueSchema = z.unknown();
type SettingsValue = z.input<typeof settingsValueSchema>;
const settingsRecordSchema = z.record(z.string(), settingsValueSchema);
type SettingsRecord = z.infer<typeof settingsRecordSchema>;
interface ProfileValues { [key: string]: string }

export type ConsoleSettingKind = "text" | "textarea" | "password" | "number" | "checkbox" | "select" | "readonly";
export type ConsoleSettingRequirement = "none" | "required" | "optional";

export type ConsoleSettingField = {
  key: string;
  label: string;
  description: string;
  kind: ConsoleSettingKind;
  requirement?: ConsoleSettingRequirement;
  placeholder?: string;
  rows?: number;
  options?: ReadonlyArray<{ value: string; label: string }>;
  /** Input size for the field control. Defaults to medium. */
  size?: "small" | "medium" | "large";
  /** Render at half width so two fields can share a row. */
  half?: boolean;
  /** Keep the GSV Worker target available, but show machine targets first. */
  preferGsvLast?: boolean;
};

export type ConsoleSettingGroup = {
  id: string;
  title: string;
  description: string;
  fields: readonly ConsoleSettingField[];
};

export type ConsoleModelProfile = {
  id: string;
  name: string;
  values: Record<string, string>;
  /** Which stack layer holds the entry; only the viewer's own layer is editable. */
  source: AiModelSource;
  createdAt: number;
  updatedAt: number;
};

/** The effective ordered stack as the Kernel reports it through `ai.models`. */
export type ConsoleModelListing = AiModelsResult;

/** Root edits the installation-wide list; everyone else edits their own. */
export function editableModelSource(uid: number | null | undefined): AiModelSource {
  return uid === 0 ? "system" : "personal";
}

export function preferredModelSaveEntry(uid: number, modelId: string | null): ConsoleConfigWrite {
  return { key: `users/${uid}/ai/preferred_model`, value: modelId ?? "" };
}

export type ConsoleConfigWrite = {
  key: string;
  value?: string;
  copyFromKey?: string;
};

export type ClearedModelProfileSecretKeys = ReadonlyMap<string, ReadonlySet<string>>;

const MODEL_STACK_VERSION = 1;
const MODEL_PROFILE_KEY = "models";
const MAX_PROFILE_NAME_LENGTH = 80;

export const AGENT_MODEL_FIELDS: readonly ConsoleSettingField[] = [
  {
    key: "config/ai/provider",
    label: "Provider",
    description: "LLM provider used by agent runs.",
    kind: "select",
    requirement: "required",
    placeholder: "workers-ai",
    options: AI_PROVIDER_OPTIONS,
    size: "large",
  },
  {
    key: "config/ai/model",
    label: "Model",
    description: "Model identifier passed to the selected provider.",
    kind: "text",
    requirement: "required",
    placeholder: "@cf/zai-org/glm-5.2",
    size: "large",
  },
  {
    key: "config/ai/base_url",
    label: "Base URL",
    description: "Custom endpoint base URL for gateway or compatible providers.",
    kind: "text",
    requirement: "optional",
    placeholder: "https://gateway.example.com/v1",
    size: "large",
  },
  {
    key: "config/ai/provider_style",
    label: "Provider style",
    description: "Request API used for custom endpoints.",
    kind: "select",
    requirement: "optional",
    size: "large",
    options: [
      { value: "auto", label: "Auto" },
      { value: "openai-chat-completions", label: "OpenAI /v1/chat/completions" },
      { value: "openai-responses", label: "OpenAI /v1/responses" },
      { value: "anthropic-messages", label: "Anthropic /v1/messages" },
    ],
  },
  {
    key: "config/ai/transport_target",
    label: "Origin machine",
    description: "Where model provider HTTP requests start: the GSV Worker or one of your machines. Use a machine when the provider blocks Cloudflare Worker IPs.",
    kind: "text",
    requirement: "optional",
    placeholder: "gsv",
    size: "large",
  },
  {
    key: "config/ai/api_key",
    label: "API key",
    description: "Some providers require an API key, while others do not.",
    kind: "password",
    placeholder: "sk-...",
    size: "large",
  },
  {
    key: "config/ai/max_tokens",
    label: "Max tokens",
    description: "Upper bound for generated response size.",
    kind: "number",
    requirement: "optional",
    size: "small",
    half: true,
  },
  {
    key: "config/ai/context_window_tokens",
    label: "Context window",
    description: "Provider context-window size when GSV cannot discover it from the model registry.",
    kind: "number",
    requirement: "optional",
    size: "small",
    half: true,
  },
];

export const MODEL_PROFILE_FIELDS: readonly ConsoleSettingField[] = AGENT_MODEL_FIELDS;
export const MODEL_PROFILE_SECRET_FIELDS: readonly ConsoleSettingField[] = MODEL_PROFILE_FIELDS
  .filter((field) => isSensitiveSettingKey(field.key));

export const TOOL_MODEL_GROUPS: readonly ConsoleSettingGroup[] = [
  {
    id: "image-read",
    title: "Moondream Image Reader",
    description: "Resource limits for captions, queries, OCR, pointing, and detection.",
    fields: [
      {
        key: "config/ai/image/read/max_bytes",
        label: "Max bytes",
        description: "Maximum stored image size sent to the image-reading model.",
        kind: "number",
        requirement: "optional",
      },
      {
        key: "config/ai/image/read/max_tokens",
        label: "Max tokens",
        description: "Maximum text tokens generated by the image-reading model.",
        kind: "number",
        requirement: "optional",
      },
      {
        key: "config/ai/image/read/max_objects",
        label: "Max objects",
        description: "Maximum points or bounding boxes returned by a request.",
        kind: "number",
        requirement: "optional",
      },
      {
        key: "config/ai/image/read/timeout_ms",
        label: "Timeout",
        description: "Maximum time to wait for Moondream output.",
        kind: "number",
        requirement: "optional",
      },
    ],
  },
  {
    id: "image-generation",
    title: "Image Generator",
    description: "Default model stack for text-to-image and image editing.",
    fields: [
      {
        key: "config/ai/image/generation/provider",
        label: "Provider",
        description: "Provider used for image generation.",
        kind: "select",
        requirement: "required",
        placeholder: "workers-ai",
        options: AI_OPENAI_WORKERS_PROVIDER_OPTIONS,
      },
      {
        key: "config/ai/image/generation/model",
        label: "Model",
        description: "Default model for image generation.",
        kind: "text",
        requirement: "required",
        placeholder: "@cf/black-forest-labs/flux-1-schnell",
      },
      {
        key: "config/ai/image/generation/api_key",
        label: "API key",
        description: "Credential owned by this image-generation configuration. Some providers do not require one.",
        kind: "password",
        placeholder: "sk-...",
      },
    ],
  },
  {
    id: "transcription",
    title: "Transcription",
    description: "Speech-to-text model stack for audio attachments.",
    fields: [
      {
        key: "config/ai/transcription/provider",
        label: "Provider",
        description: "Provider used by transcription requests.",
        kind: "select",
        requirement: "required",
        placeholder: "workers-ai",
        options: AI_OPENAI_WORKERS_PROVIDER_OPTIONS,
      },
      {
        key: "config/ai/transcription/model",
        label: "Model",
        description: "Speech-to-text model used for audio attachments.",
        kind: "text",
        requirement: "required",
        placeholder: "@cf/openai/whisper-large-v3-turbo",
      },
      {
        key: "config/ai/transcription/api_key",
        label: "API key",
        description: "Credential owned by this transcription configuration. Some providers do not require one.",
        kind: "password",
        placeholder: "sk-...",
      },
      {
        key: "config/ai/transcription/max_bytes",
        label: "Max bytes",
        description: "Maximum audio payload size accepted for transcription.",
        kind: "number",
        requirement: "optional",
      },
    ],
  },
  {
    id: "speech",
    title: "Speech",
    description: "Text-to-speech model stack.",
    fields: [
      {
        key: "config/ai/speech/provider",
        label: "Provider",
        description: "Provider used by speech synthesis.",
        kind: "select",
        requirement: "required",
        placeholder: "workers-ai",
        options: AI_OPENAI_WORKERS_PROVIDER_OPTIONS,
      },
      {
        key: "config/ai/speech/model",
        label: "Model",
        description: "Text-to-speech model used by speech synthesis.",
        kind: "text",
        requirement: "required",
        placeholder: "@cf/deepgram/aura-2-en",
      },
      {
        key: "config/ai/speech/api_key",
        label: "API key",
        description: "Credential owned by this speech configuration. Some providers do not require one.",
        kind: "password",
        placeholder: "sk-...",
      },
      {
        key: "config/ai/speech/speaker",
        label: "Speaker",
        description: "Default voice or speaker.",
        kind: "text",
        requirement: "optional",
        placeholder: "luna",
      },
      {
        key: "config/ai/speech/encoding",
        label: "Encoding",
        description: "Default audio encoding for synthesized speech.",
        kind: "text",
        requirement: "optional",
        placeholder: "mp3",
      },
      {
        key: "config/ai/speech/max_chars",
        label: "Max chars",
        description: "Maximum normalized text length accepted for speech synthesis.",
        kind: "number",
        requirement: "optional",
      },
      {
        key: "config/ai/speech/timeout_ms",
        label: "Timeout",
        description: "Maximum time to wait for speech synthesis.",
        kind: "number",
        requirement: "optional",
      },
    ],
  },
];

export const RUNTIME_SETTING_GROUPS: readonly ConsoleSettingGroup[] = [
  {
    id: "shell",
    title: "Shell",
    description: "Defaults for native shell execution.",
    fields: [
      {
        key: "config/shell/timeout_ms",
        label: "Timeout",
        description: "Default timeout for native shell execution.",
        kind: "number",
      },
      {
        key: "config/shell/network_enabled",
        label: "Network",
        description: "Allow network-capable shell tools such as curl and wget.",
        kind: "checkbox",
      },
      {
        key: "config/shell/max_output_bytes",
        label: "Max output bytes",
        description: "Maximum captured shell output before truncation.",
        kind: "number",
      },
    ],
  },
  {
    id: "server",
    title: "Server",
    description: "Instance metadata used by system tools and scheduling.",
    fields: [
      {
        key: "config/server/name",
        label: "Instance name",
        description: "Human-readable name shown by system tools and shell surfaces.",
        kind: "text",
      },
      {
        key: "config/server/timezone",
        label: "Timezone",
        description: "IANA timezone used for scheduling and timestamps.",
        kind: "text",
        placeholder: "Europe/Amsterdam",
      },
      {
        key: "config/server/version",
        label: "Version",
        description: "Current server version reported by the runtime.",
        kind: "readonly",
      },
    ],
  },
];

export function viewerAccountForSettings(accounts: readonly ConsoleAccount[]): ConsoleAccount | null {
  return accounts.find((account) => account.relation === "self")
    ?? accounts.find((account) => account.uid === 0)
    ?? null;
}

export function buildUserAiOverrideKey(uid: number, systemKey: string): string {
  if (!systemKey.startsWith("config/ai/")) {
    throw new Error(`Cannot build user AI override for non-AI key: ${systemKey}`);
  }
  return `users/${uid}/${systemKey.slice("config/".length)}`;
}

export function modelProfilesConfigKey(uid: number): string {
  return uid === 0 ? "config/ai/models" : `users/${uid}/ai/${MODEL_PROFILE_KEY}`;
}

export function modelProfileSecretConfigKey(uid: number, profileId: string, fieldKey: string): string {
  if (!fieldKey.startsWith("config/ai/")) {
    throw new Error(`Cannot build model credential key for non-AI key: ${fieldKey}`);
  }
  const normalizedProfileId = normalizeProfileId(profileId);
  if (!normalizedProfileId) {
    throw new Error("Model id is required");
  }
  return `${modelProfilesConfigKey(uid)}/${normalizedProfileId}/${fieldKey.slice("config/ai/".length)}`;
}

export function configEntryForKey(
  config: readonly ConsoleConfigEntry[],
  key: string,
): ConsoleConfigEntry | null {
  return config.find((entry) => entry.key === key) ?? null;
}

export function configValueForKey(
  config: readonly ConsoleConfigEntry[],
  key: string,
): string {
  const entry = configEntryForKey(config, key);
  return entry && !entry.redacted ? entry.value : "";
}

export function configValueMap(config: readonly ConsoleConfigEntry[]) {
  const values: Record<string, string> = {};
  for (const entry of config) {
    if (!entry.redacted) {
      values[entry.key] = entry.value;
    }
  }
  return values;
}

export function effectiveAiValuesForViewer(
  config: readonly ConsoleConfigEntry[],
  uid: number | null | undefined,
  primaryModel: ConsoleModelProfile | null = null,
) {
  const values: Record<string, string> = {};
  for (const field of allAiSettingFields()) {
    values[field.key] = configValueForKey(config, field.key);
  }
  const validUid = z.number().finite().safeParse(uid);
  if (!validUid.success) {
    return values;
  }
  if (validUid.data !== 0) {
    for (const group of TOOL_MODEL_GROUPS) {
      const connectionFields = group.fields.filter((field) =>
        isMediaConnectionField(field.key)
      );
      const connectionIsPersonal = connectionFields.some((field) =>
        configEntryForKey(config, buildUserAiOverrideKey(validUid.data, field.key)) !== null
      );
      for (const field of group.fields) {
        const overrideKey = buildUserAiOverrideKey(validUid.data, field.key);
        const overrideValue = cleanValue(configValueForKey(config, overrideKey));
        if (connectionIsPersonal && isMediaConnectionField(field.key)) {
          values[field.key] = overrideValue;
        } else if (overrideValue !== "") {
          values[field.key] = overrideValue;
        }
      }
    }
  }
  if (primaryModel) {
    Object.assign(values, primaryModel.values);
  }
  return values;
}

function isMediaConnectionField(key: string): boolean {
  return key.endsWith("/provider") ||
    key.endsWith("/model") ||
    key.endsWith("/api_key") ||
    key === "config/ai/speech/speaker";
}

/**
 * Projects the Kernel's effective stack into console profiles. Entries from
 * the viewer's own layer get their stored credential hydrated for editing;
 * every other layer is shown as it is.
 */
export function modelProfilesFromListing(
  listing: ConsoleModelListing | null,
  config: readonly ConsoleConfigEntry[],
  uid: number | null | undefined,
): ConsoleModelProfile[] {
  if (!listing) {
    return [];
  }
  const validUid = z.number().finite().safeParse(uid);
  const editable = validUid.success ? editableModelSource(validUid.data) : null;
  const profiles: ConsoleModelProfile[] = [];
  for (const entry of listing.models) {
    const profile = normalizeCanonicalModel(entry, entry.source);
    if (!profile) continue;
    profiles.push(
      validUid.success && entry.source === editable
        ? hydrateModelProfileSecrets(config, modelProfilesConfigKey(validUid.data), profile)
        : profile,
    );
  }
  return profiles;
}

export function serializeModelProfiles(profiles: readonly ConsoleModelProfile[]): string {
  return JSON.stringify({
    version: MODEL_STACK_VERSION,
    models: profiles.map((profile) => ({
      id: profile.id,
      name: normalizeProfileName(profile.name),
      ...canonicalModelValues(profile.values),
    })),
  });
}

export function modelProfileSaveEntries(
  uid: number | null,
  nextProfiles: readonly ConsoleModelProfile[],
  clearedSecretKeys: ClearedModelProfileSecretKeys = new Map(),
): ConsoleConfigWrite[] {
  if (uid === null) {
    throw new Error("A signed-in account is required to save models.");
  }
  const entries: ConsoleConfigWrite[] = [{
    key: modelProfilesConfigKey(uid),
    value: nextProfiles.length > 0 ? serializeModelProfiles(nextProfiles) : "",
  }];
  for (const profile of nextProfiles) {
    const clearedForProfile = clearedSecretKeys.get(profile.id);
    for (const field of MODEL_PROFILE_SECRET_FIELDS) {
      const value = profile.values[field.key] ?? "";
      if (clearedForProfile?.has(field.key)) {
        entries.push({
          key: modelProfileSecretConfigKey(uid, profile.id, field.key),
          value: "",
        });
      } else if (value.length > 0) {
        entries.push({
          key: modelProfileSecretConfigKey(uid, profile.id, field.key),
          value,
        });
      }
    }
  }
  return entries;
}

export function createModelProfile(
  profiles: readonly ConsoleModelProfile[],
  name: string,
  values: Record<string, string>,
  now = Date.now(),
  source: AiModelSource = "personal",
): ConsoleModelProfile[] {
  const normalizedName = normalizeProfileName(name);
  if (!normalizedName) {
    throw new Error("Model name is required");
  }
  if (profiles.some((profile) => profile.name.toLowerCase() === normalizedName.toLowerCase())) {
    throw new Error("Model name already exists");
  }
  return [
    ...profiles,
    {
      id: uniqueProfileId(profiles, normalizedName),
      name: normalizedName,
      values: normalizeProfileValues(values),
      source,
      createdAt: now,
      updatedAt: now,
    },
  ];
}

export function makeModelPrimary(
  profiles: readonly ConsoleModelProfile[],
  profileId: string,
): ConsoleModelProfile[] {
  const index = profiles.findIndex((profile) => profile.id === profileId);
  if (index <= 0) return [...profiles];
  return [
    profiles[index],
    ...profiles.slice(0, index),
    ...profiles.slice(index + 1),
  ];
}

export function updateModelProfile(
  profiles: readonly ConsoleModelProfile[],
  profileId: string,
  name: string,
  values: Record<string, string>,
  now = Date.now(),
): ConsoleModelProfile[] {
  const normalizedName = normalizeProfileName(name);
  if (!normalizedName) {
    throw new Error("Model name is required");
  }
  return profiles.map((profile) => profile.id === profileId
    ? {
        ...profile,
        name: normalizedName,
        values: normalizeProfileValues(values),
        updatedAt: now,
      }
    : profile);
}

export function deleteModelProfile(
  profiles: readonly ConsoleModelProfile[],
  profileId: string,
): ConsoleModelProfile[] {
  return profiles.filter((profile) => profile.id !== profileId);
}

export function profileValuesFromDrafts(values: Record<string, string>): Record<string, string> {
  return normalizeProfileValues(values);
}

export function modelValidationValuesFromProfileDrafts(
  values: Record<string, string>,
  clearedSecretKeys: ReadonlySet<string> = new Set(),
): ProfileValues {
  const validationValues = { ...values };
  for (const field of MODEL_PROFILE_SECRET_FIELDS) {
    if (validationValues[field.key] === "" && !clearedSecretKeys.has(field.key)) {
      delete validationValues[field.key];
    }
  }
  return validationValues;
}

export function modelProfileSummary(values: Record<string, string>): string {
  const provider = cleanValue(values["config/ai/provider"]) || "provider";
  const model = cleanValue(values["config/ai/model"]) || "model";
  if (fixedAiProviderModel(provider)) {
    return aiProviderDisplayLabel(provider);
  }
  return `${provider} / ${modelDisplayName(model)}`;
}

export function modelStackDisplayName(values: Record<string, string>): string {
  const provider = cleanValue(values["config/ai/provider"]);
  if (fixedAiProviderModel(provider)) {
    return aiProviderDisplayLabel(provider);
  }
  return modelDisplayName(values["config/ai/model"] ?? "");
}

export function modelDisplayName(value: string): string {
  const shortName = shortModelName(value);
  if (!shortName) {
    return "";
  }
  return shortName
    .split(/[-_\s.]+/)
    .filter(Boolean)
    .map(formatModelNamePart)
    .join(" ");
}

export function shortModelName(value: string): string {
  const normalized = cleanValue(value);
  if (!normalized) {
    return "";
  }
  if (normalized.startsWith("@cf/")) {
    const parts = normalized.split("/").filter(Boolean);
    return parts[parts.length - 1] || normalized;
  }
  if (normalized.includes("/")) {
    const parts = normalized.split("/").filter(Boolean);
    return parts[parts.length - 1] || normalized;
  }
  return normalized;
}

function formatModelNamePart(part: string): string {
  const upper = part.toUpperCase();
  if (/^[a-z]?\d+[a-z]?$/i.test(part) || upper.length <= 3) {
    return upper;
  }
  return `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
}

export function isSensitiveSettingKey(key: string): boolean {
  return /(?:^|\/|_)(?:api[_-]?key|password|secret|token|credential)(?:$|\/|_)/i.test(key);
}

export function allAiSettingFields(): ConsoleSettingField[] {
  return [
    ...AGENT_MODEL_FIELDS,
    ...TOOL_MODEL_GROUPS.flatMap((group) => group.fields),
  ];
}

export function allModeledSettingKeys(): Set<string> {
  return new Set([
    ...allAiSettingFields(),
    ...RUNTIME_SETTING_GROUPS.flatMap((group) => group.fields),
  ].map((field) => field.key));
}

function normalizeCanonicalModel(
  raw: SettingsValue | AiModelListEntry,
  source: AiModelSource,
): ConsoleModelProfile | null {
  const parsed = z.object({
    id: z.string(),
    name: z.string(),
    provider: z.string(),
    model: z.string(),
    baseUrl: z.string().optional(),
    providerStyle: z.string().optional(),
    transportTarget: z.string().optional(),
    maxTokens: z.number().int().positive().optional(),
    contextWindowTokens: z.number().int().positive().optional(),
  }).safeParse(raw);
  if (!parsed.success) return null;
  const id = normalizeProfileId(parsed.data.id);
  const name = normalizeProfileName(parsed.data.name);
  const provider = parsed.data.provider.trim();
  const model = parsed.data.model.trim();
  if (!id || !name || !provider || !model) return null;
  return {
    id,
    name,
    values: normalizeProfileValues({
      "config/ai/provider": provider,
      "config/ai/model": model,
      "config/ai/base_url": parsed.data.baseUrl ?? "",
      "config/ai/provider_style": parsed.data.providerStyle ?? "",
      "config/ai/transport_target": parsed.data.transportTarget ?? "",
      "config/ai/max_tokens": parsed.data.maxTokens ?? "",
      "config/ai/context_window_tokens": parsed.data.contextWindowTokens ?? "",
      "config/ai/api_key": "",
    }),
    source,
    createdAt: 0,
    updatedAt: 0,
  };
}

function normalizeProfileValues(values: SettingsRecord): ProfileValues {
  const normalized: ProfileValues = {};
  for (const field of MODEL_PROFILE_FIELDS) {
    normalized[field.key] = String(values[field.key] ?? "");
  }
  return normalized;
}

function hydrateModelProfileSecrets(
  config: readonly ConsoleConfigEntry[],
  stackKey: string,
  profile: ConsoleModelProfile,
): ConsoleModelProfile {
  const values = { ...profile.values };
  for (const field of MODEL_PROFILE_SECRET_FIELDS) {
    const secret = configValueForKey(
      config,
      `${stackKey}/${profile.id}/${field.key.slice("config/ai/".length)}`,
    );
    if (secret) {
      values[field.key] = secret;
    }
  }
  return { ...profile, values };
}

interface CanonicalModelValues {
  provider: string;
  model: string;
  baseUrl?: string;
  providerStyle?: string;
  transportTarget?: string;
  maxTokens?: number;
  contextWindowTokens?: number;
}

function canonicalModelValues(values: SettingsRecord): CanonicalModelValues {
  const baseUrl = cleanValue(values["config/ai/base_url"]);
  const providerStyle = cleanValue(values["config/ai/provider_style"]);
  const transportTarget = cleanValue(values["config/ai/transport_target"]);
  const maxTokens = optionalPositiveInt(values["config/ai/max_tokens"]);
  const contextWindowTokens = optionalPositiveInt(
    values["config/ai/context_window_tokens"],
  );
  const result: CanonicalModelValues = {
    provider: cleanValue(values["config/ai/provider"]),
    model: cleanValue(values["config/ai/model"]),
  };
  if (baseUrl) result.baseUrl = baseUrl;
  if (providerStyle) result.providerStyle = providerStyle;
  if (transportTarget) result.transportTarget = transportTarget;
  if (maxTokens) result.maxTokens = maxTokens;
  if (contextWindowTokens) result.contextWindowTokens = contextWindowTokens;
  return result;
}

function optionalPositiveInt(
  value: SettingsValue,
): number | undefined {
  const normalized = cleanValue(value);
  if (!normalized) return undefined;
  const parsed = Number(normalized);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function normalizeProfileName(value: SettingsValue): string {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, MAX_PROFILE_NAME_LENGTH);
}

function normalizeProfileId(value: SettingsValue): string {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

function uniqueProfileId(profiles: readonly ConsoleModelProfile[], name: string): string {
  const used = new Set(profiles.map((profile) => profile.id));
  const base = slugify(name) || "profile";
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function cleanValue(value: SettingsValue): string {
  return String(value ?? "").trim();
}
