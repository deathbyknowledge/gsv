import {
  AI_FIELDS,
  AUTOMATION_FIELDS,
  PROCESS_FIELDS,
  PROFILE_CONTEXT_FIELDS,
  PROFILE_OPTIONS,
  SERVER_FIELDS,
  SHELL_FIELDS,
  buildProfileApprovalKey,
  buildProfileContextKey,
} from "./config-schema";
import type { ConfigEntry, SettingField } from "./types";

export function formatDate(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value).toLocaleString() : "never";
}

export function buildDrafts(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, shouldPrettyPrintJson(key, value) ? prettyJson(value) : value]),
  );
}

export function serializeConfigValue(key: string, value: string): string {
  if (key.endsWith("/tools/approval")) {
    try {
      return JSON.stringify(JSON.parse(value));
    } catch {
      return value;
    }
  }
  return value;
}

export function settingFieldsForRuntime(): SettingField[] {
  return [
    ...SHELL_FIELDS,
    ...SERVER_FIELDS,
    ...PROCESS_FIELDS,
    ...AUTOMATION_FIELDS,
  ];
}

export function modeledConfigKeys(): Set<string> {
  const keys = new Set<string>([
    ...AI_FIELDS,
    ...SHELL_FIELDS,
    ...SERVER_FIELDS,
    ...PROCESS_FIELDS,
    ...AUTOMATION_FIELDS,
  ].map((field) => field.key));
  for (const profile of PROFILE_OPTIONS) {
    for (const contextField of PROFILE_CONTEXT_FIELDS) {
      keys.add(buildProfileContextKey(profile.id, contextField.file));
    }
    keys.add(buildProfileApprovalKey(profile.id));
  }
  return keys;
}

export function unmodeledEntries(entries: ConfigEntry[]): ConfigEntry[] {
  const modeled = modeledConfigKeys();
  return entries.filter((entry) => !modeled.has(entry.key));
}

export function summarizeValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "none";
  }
  const singleLine = trimmed.replace(/\s+/g, " ");
  return singleLine.length > 84 ? `${singleLine.slice(0, 81)}...` : singleLine;
}

export function isWideField(field: SettingField): boolean {
  return field.kind === "textarea" || field.kind === "json";
}

function shouldPrettyPrintJson(key: string, value: string): boolean {
  return key.endsWith("/tools/approval") && value.trim().startsWith("{");
}

function prettyJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}
