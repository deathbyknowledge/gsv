import { AI_FIELDS, buildUserAiOverrideKey } from "./config-schema";
import type {
  AdministrationViewer,
  ModelProfile,
  SaveConfigEntry,
} from "./types";

const MODEL_PROFILES_VERSION = 1;
const MODEL_PROFILE_KEY = "model_profiles";
const MAX_PROFILE_NAME_LENGTH = 80;

type ModelProfilesPayload = {
  version?: number;
  profiles?: unknown[];
};

export function modelProfilesConfigKey(uid: number): string {
  return `users/${uid}/ai/${MODEL_PROFILE_KEY}`;
}

export function isModelProfilesConfigKey(key: string): boolean {
  return /^users\/\d+\/ai\/model_profiles$/.test(key);
}

export function readModelProfiles(values: Record<string, string>, uid: number): ModelProfile[] {
  const raw = values[modelProfilesConfigKey(uid)];
  if (!raw) {
    return [];
  }

  try {
    const payload = JSON.parse(raw) as ModelProfilesPayload;
    const profiles = Array.isArray(payload.profiles) ? payload.profiles : [];
    return profiles
      .map(normalizeModelProfile)
      .filter((profile): profile is ModelProfile => profile !== null)
      .sort((left, right) => right.updatedAt - left.updatedAt || left.name.localeCompare(right.name));
  } catch {
    return [];
  }
}

export function serializeModelProfiles(profiles: ModelProfile[]): string {
  return JSON.stringify({
    version: MODEL_PROFILES_VERSION,
    profiles: profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      values: normalizeProfileValues(profile.values),
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    })),
  });
}

export function createModelProfile(
  profiles: ModelProfile[],
  name: string,
  values: Record<string, string>,
  now = Date.now(),
): ModelProfile[] {
  const normalizedName = normalizeProfileName(name);
  if (!normalizedName) {
    throw new Error("Profile name is required");
  }

  const existing = profiles.find((profile) => profile.name.toLowerCase() === normalizedName.toLowerCase());
  if (existing) {
    return updateModelProfile(profiles, existing.id, values, now);
  }

  return [
    {
      id: uniqueProfileId(profiles, normalizedName),
      name: normalizedName,
      values: normalizeProfileValues(values),
      createdAt: now,
      updatedAt: now,
    },
    ...profiles,
  ];
}

export function updateModelProfile(
  profiles: ModelProfile[],
  profileId: string,
  values: Record<string, string>,
  now = Date.now(),
): ModelProfile[] {
  return profiles.map((profile) => profile.id === profileId
    ? {
        ...profile,
        values: normalizeProfileValues(values),
        updatedAt: now,
      }
    : profile);
}

export function removeModelProfile(profiles: ModelProfile[], profileId: string): ModelProfile[] {
  return profiles.filter((profile) => profile.id !== profileId);
}

export function buildApplyModelProfileEntries(
  profile: ModelProfile,
  viewer: AdministrationViewer,
  overrideAiForUser: boolean,
): SaveConfigEntry[] {
  return AI_FIELDS
    .filter((field) => field.kind !== "readonly")
    .map((field) => ({
      key: overrideAiForUser ? buildUserAiOverrideKey(viewer.uid, field.key) : field.key,
      value: profile.values[field.key] ?? "",
    }));
}

export function modelProfileMatches(profile: ModelProfile, values: Record<string, string>): boolean {
  return AI_FIELDS.every((field) => (profile.values[field.key] ?? "") === (values[field.key] ?? ""));
}

export function modelProfileSummary(profile: ModelProfile): string {
  const chatProvider = summarizeProfileValue(profile.values["config/ai/provider"], "chat provider");
  const chatModel = summarizeProfileValue(profile.values["config/ai/model"], "chat model");
  const imageProvider = summarizeProfileValue(profile.values["config/ai/image/read/provider"], "image provider");
  const imageModel = summarizeProfileValue(profile.values["config/ai/image/read/model"], "image reader");
  const transcriptionProvider = summarizeProfileValue(profile.values["config/ai/transcription/provider"], "audio provider");
  const transcriptionModel = summarizeProfileValue(profile.values["config/ai/transcription/model"], "transcription");
  const speechProvider = summarizeProfileValue(profile.values["config/ai/speech/provider"], "speech provider");
  const speechModel = summarizeProfileValue(profile.values["config/ai/speech/model"], "speech");
  return `chat ${chatProvider}/${chatModel} - image ${imageProvider}/${imageModel} - audio ${transcriptionProvider}/${transcriptionModel} - speech ${speechProvider}/${speechModel}`;
}

export function profileValuesFromDrafts(values: Record<string, string>): Record<string, string> {
  return normalizeProfileValues(values);
}

function normalizeModelProfile(raw: unknown): ModelProfile | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const id = normalizeId(record.id);
  const name = normalizeProfileName(record.name);
  if (!id || !name) {
    return null;
  }
  const createdAt = normalizeTimestamp(record.createdAt);
  const updatedAt = normalizeTimestamp(record.updatedAt) || createdAt;

  return {
    id,
    name,
    values: normalizeProfileValues(
      record.values && typeof record.values === "object"
        ? record.values as Record<string, unknown>
        : {},
    ),
    createdAt,
    updatedAt,
  };
}

function normalizeProfileValues(values: Record<string, unknown>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const field of AI_FIELDS) {
    normalized[field.key] = String(values[field.key] ?? "");
  }
  return normalized;
}

function normalizeProfileName(value: unknown): string {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, MAX_PROFILE_NAME_LENGTH);
}

function normalizeId(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

function normalizeTimestamp(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : Date.now();
}

function uniqueProfileId(profiles: ModelProfile[], name: string): string {
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

function summarizeProfileValue(value: string | undefined, fallback: string): string {
  const normalized = (value ?? "").trim();
  if (!normalized) {
    return fallback;
  }
  return normalized.length > 34 ? `${normalized.slice(0, 31)}...` : normalized;
}
