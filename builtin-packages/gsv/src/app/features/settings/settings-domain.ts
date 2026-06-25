import {
  AI_FIELDS,
  SERVER_FIELDS,
  SHELL_FIELDS,
} from "./config-schema";
import { isModelProfilesConfigKey } from "./model-profiles-domain";
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
  ];
}

export function modeledConfigKeys(): Set<string> {
  const keys = new Set<string>([
    ...AI_FIELDS,
    ...SHELL_FIELDS,
    ...SERVER_FIELDS,
  ].map((field) => field.key));
  return keys;
}

export function unmodeledEntries(entries: ConfigEntry[]): ConfigEntry[] {
  return entries.filter((entry) => !isModeledConfigKey(entry.key));
}

export function isModeledConfigKey(key: string): boolean {
  const modeled = modeledConfigKeys();
  if (modeled.has(key) || isModelProfilesConfigKey(key)) {
    return true;
  }
  const userAiMatch = /^users\/\d+\/ai\/(.+)$/.exec(key);
  return userAiMatch ? modeled.has(`config/ai/${userAiMatch[1]}`) : false;
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
