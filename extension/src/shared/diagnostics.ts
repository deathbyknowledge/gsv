import type { ActivityEntry } from "./ui-state";

export type ExtensionDiagnostics = {
  activity: ActivityEntry[];
  artifactPaths: string[];
  lastConnectAttemptAt: string | null;
  lastConnectedAt: string | null;
  lastDisconnectedAt: string | null;
  lastSuccessfulConnectionId: string | null;
  lastConnectionErrorAt: string | null;
  lastConnectionError: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  updatedAt: string | null;
};

const DIAGNOSTICS_KEY = "gsvExtensionDiagnostics";
const MAX_ACTIVITY = 80;
const MAX_ARTIFACT_PATHS = 200;

export function emptyDiagnostics(): ExtensionDiagnostics {
  return {
    activity: [],
    artifactPaths: [],
    lastConnectAttemptAt: null,
    lastConnectedAt: null,
    lastDisconnectedAt: null,
    lastSuccessfulConnectionId: null,
    lastConnectionErrorAt: null,
    lastConnectionError: null,
    lastErrorAt: null,
    lastError: null,
    updatedAt: null,
  };
}

export async function loadDiagnostics(): Promise<ExtensionDiagnostics> {
  const raw = await chrome.storage.local.get(DIAGNOSTICS_KEY);
  return normalizeDiagnostics(raw[DIAGNOSTICS_KEY]);
}

export async function saveDiagnostics(diagnostics: ExtensionDiagnostics): Promise<void> {
  await chrome.storage.local.set({
    [DIAGNOSTICS_KEY]: normalizeDiagnostics(diagnostics),
  });
}

export async function clearDiagnostics(): Promise<void> {
  await chrome.storage.local.remove(DIAGNOSTICS_KEY);
}

export function mergeDiagnostics(...values: ExtensionDiagnostics[]): ExtensionDiagnostics {
  const merged = emptyDiagnostics();
  const activityById = new Map<string, ActivityEntry>();
  const artifactPaths = new Set<string>();

  for (const value of values) {
    for (const entry of value.activity) {
      activityById.set(entry.id, entry);
    }
    for (const path of value.artifactPaths) {
      artifactPaths.add(path);
    }

    mergeLatestTimestamp(merged, value, "lastConnectAttemptAt");
    mergeLatestTimestamp(merged, value, "lastConnectedAt");
    mergeLatestTimestamp(merged, value, "lastDisconnectedAt");
    mergeLatestTimestamp(merged, value, "lastConnectionErrorAt", "lastConnectionError");
    mergeLatestTimestamp(merged, value, "lastErrorAt", "lastError");
    mergeLatestTimestamp(merged, value, "updatedAt");

    if (value.lastConnectedAt && value.lastConnectedAt === merged.lastConnectedAt) {
      merged.lastSuccessfulConnectionId = value.lastSuccessfulConnectionId;
    }
  }

  merged.activity = sortActivity([...activityById.values()]).slice(0, MAX_ACTIVITY);
  merged.artifactPaths = [...artifactPaths].sort().slice(0, MAX_ARTIFACT_PATHS);
  return merged;
}

export function recordDiagnosticActivity(
  diagnostics: ExtensionDiagnostics,
  entry: ActivityEntry,
): ExtensionDiagnostics {
  const next = normalizeDiagnostics(diagnostics);
  next.activity = sortActivity([
    entry,
    ...next.activity.filter((candidate) => candidate.id !== entry.id),
  ]).slice(0, MAX_ACTIVITY);
  next.updatedAt = entry.at;

  if (entry.kind === "connection") {
    if (entry.label === "connecting") {
      next.lastConnectAttemptAt = entry.at;
    } else if (entry.label === "connected") {
      next.lastConnectedAt = entry.at;
      next.lastSuccessfulConnectionId = entry.detail || null;
    } else if (entry.label === "disconnected") {
      next.lastDisconnectedAt = entry.at;
    }
    if (entry.status === "error") {
      next.lastConnectionErrorAt = entry.at;
      next.lastConnectionError = entry.detail;
    }
  }

  if (entry.kind === "error" || entry.status === "error") {
    next.lastErrorAt = entry.at;
    next.lastError = `${entry.label}: ${entry.detail}`;
    if (entry.kind === "connection") {
      next.lastConnectionErrorAt = entry.at;
      next.lastConnectionError = entry.detail;
    }
  }

  return next;
}

export function recordDiagnosticArtifactPaths(
  diagnostics: ExtensionDiagnostics,
  paths: Iterable<string>,
): ExtensionDiagnostics {
  const next = normalizeDiagnostics(diagnostics);
  const unique = new Set(next.artifactPaths);
  for (const path of paths) {
    if (path) {
      unique.add(path);
    }
  }
  next.artifactPaths = [...unique].sort().slice(0, MAX_ARTIFACT_PATHS);
  next.updatedAt = new Date().toISOString();
  return next;
}

function normalizeDiagnostics(value: unknown): ExtensionDiagnostics {
  const record = isRecord(value) ? value : {};
  const diagnostics = emptyDiagnostics();
  diagnostics.activity = normalizeActivity(record.activity);
  diagnostics.artifactPaths = normalizeStringArray(record.artifactPaths).slice(0, MAX_ARTIFACT_PATHS);
  diagnostics.lastConnectAttemptAt = normalizeIso(record.lastConnectAttemptAt);
  diagnostics.lastConnectedAt = normalizeIso(record.lastConnectedAt);
  diagnostics.lastDisconnectedAt = normalizeIso(record.lastDisconnectedAt);
  diagnostics.lastSuccessfulConnectionId = normalizeString(record.lastSuccessfulConnectionId);
  diagnostics.lastConnectionErrorAt = normalizeIso(record.lastConnectionErrorAt);
  diagnostics.lastConnectionError = normalizeString(record.lastConnectionError);
  diagnostics.lastErrorAt = normalizeIso(record.lastErrorAt);
  diagnostics.lastError = normalizeString(record.lastError);
  diagnostics.updatedAt = normalizeIso(record.updatedAt);
  return diagnostics;
}

function normalizeActivity(value: unknown): ActivityEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const entries: ActivityEntry[] = [];
  for (const item of value) {
    const record = isRecord(item) ? item : {};
    const id = normalizeString(record.id);
    const kind = normalizeString(record.kind);
    const status = normalizeString(record.status);
    const at = normalizeIso(record.at);
    if (!id || !at || !isActivityKind(kind) || !isActivityStatus(status)) {
      continue;
    }
    const durationMs = typeof record.durationMs === "number" && Number.isFinite(record.durationMs)
      ? Math.max(0, Math.round(record.durationMs))
      : undefined;
    entries.push({
      id,
      kind,
      label: normalizeString(record.label) ?? "",
      detail: normalizeString(record.detail) ?? "",
      status,
      at,
      ...(durationMs === undefined ? {} : { durationMs }),
    });
  }
  return sortActivity(entries).slice(0, MAX_ACTIVITY);
}

function sortActivity(entries: ActivityEntry[]): ActivityEntry[] {
  return entries.sort((left, right) => Date.parse(right.at) - Date.parse(left.at));
}

function mergeLatestTimestamp<K extends keyof ExtensionDiagnostics>(
  target: ExtensionDiagnostics,
  source: ExtensionDiagnostics,
  timestampKey: K,
  valueKey?: keyof ExtensionDiagnostics,
): void {
  const sourceTimestamp = source[timestampKey];
  if (typeof sourceTimestamp !== "string") {
    return;
  }
  const targetTimestamp = target[timestampKey];
  if (typeof targetTimestamp === "string" && Date.parse(targetTimestamp) >= Date.parse(sourceTimestamp)) {
    return;
  }
  target[timestampKey] = sourceTimestamp as ExtensionDiagnostics[K];
  if (valueKey) {
    target[valueKey] = source[valueKey] as never;
  }
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeIso(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function isActivityKind(value: string | null): value is ActivityEntry["kind"] {
  return value === "shell"
    || value === "fs"
    || value === "connection"
    || value === "network"
    || value === "sensitive"
    || value === "error";
}

function isActivityStatus(value: string | null): value is ActivityEntry["status"] {
  return value === "active" || value === "ok" || value === "error" || value === "info";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
