import type {
  FilesContentItem,
  FilesDeletePayload,
  FilesDirectoryEntry,
  FilesDirectoryPayload,
  FilesErrorPayload,
  FilesFilePayload,
  FilesReadPayload,
  FilesSearchMatch,
  FilesSearchPayload,
  FilesTarget,
  FilesWritePayload,
} from "./models";
import { childPath, detectPathStyle, normalizePath, normalizeTarget, parentPath } from "./paths";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function decodeNumberedText(content: string): string {
  return content
    .split("\n")
    .map((line) => line.replace(/^\s*\d+\t/, ""))
    .join("\n");
}

function normalizeContent(content: unknown): string | FilesContentItem[] {
  if (typeof content === "string") {
    return decodeNumberedText(content);
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => item !== null)
    .map((item) => {
      if (item.type === "image") {
        return {
          type: "image" as const,
          mimeType: asString(item.mimeType) ?? undefined,
          data: asString(item.data) ?? undefined,
        };
      }
      return {
        type: "text" as const,
        text: asString(item.text) ?? "",
      };
    });
}

export function normalizeFilesTargets(payload: unknown): FilesTarget[] {
  const record = asRecord(payload);
  const rawDevices = Array.isArray(payload) ? payload : Array.isArray(record?.devices) ? record.devices : [];
  const targets = rawDevices
    .map((device) => {
      const item = asRecord(device) ?? {};
      const id = asString(item.deviceId) ?? asString(item.id) ?? "";
      if (!id) {
        return null;
      }
      return {
        id,
        label: asString(item.label) ?? id,
        online: asBoolean(item.online) ?? false,
        platform: asString(item.platform) ?? "",
        description: asString(item.description) ?? "",
        ownerUsername: asString(item.ownerUsername),
        lastSeenAt: asNumber(item.lastSeenAt),
      };
    })
    .filter((target): target is FilesTarget => target !== null)
    .sort((left, right) => left.id.localeCompare(right.id));

  return targets;
}

export function normalizeFilesRead(payload: unknown, target: string, requestedPath: string): FilesReadPayload | FilesErrorPayload {
  const normalizedTarget = normalizeTarget(target);
  const record = asRecord(payload);
  const fallbackPath = normalizePath(requestedPath, detectPathStyle(requestedPath));

  if (!record || record.ok !== true) {
    return {
      ok: false,
      target: normalizedTarget,
      path: fallbackPath,
      error: asString(record?.error) ?? `Unable to open ${fallbackPath}`,
    };
  }

  const path = normalizePath(asString(record.path) ?? fallbackPath, detectPathStyle(asString(record.path) ?? fallbackPath));
  const pathStyle = detectPathStyle(path);

  if (Array.isArray(record.files) || Array.isArray(record.directories)) {
    const directories = asStringArray(record.directories).map((name): FilesDirectoryEntry => ({
      name,
      path: childPath(path, name),
      kind: "directory",
    }));
    const files = asStringArray(record.files).map((name): FilesDirectoryEntry => ({
      name,
      path: childPath(path, name),
      kind: "file",
    }));

    return {
      ok: true,
      target: normalizedTarget,
      path,
      pathStyle,
      entries: [...directories, ...files],
    };
  }

  return {
    ok: true,
    target: normalizedTarget,
    path,
    directoryPath: parentPath(path, pathStyle),
    pathStyle,
    content: normalizeContent(record.content),
    size: asNumber(record.size),
    lines: asNumber(record.lines),
  };
}

export function normalizeFilesSearch(
  payload: unknown,
  target: string,
  path: string,
  query: string,
): FilesSearchPayload | FilesErrorPayload {
  const normalizedPath = normalizePath(path, detectPathStyle(path));
  const record = asRecord(payload);
  if (!record || record.ok !== true) {
    return {
      ok: false,
      target: normalizeTarget(target),
      path: normalizedPath,
      error: asString(record?.error) ?? "Search failed",
    };
  }

  const matches: FilesSearchMatch[] = (Array.isArray(record.matches) ? record.matches : [])
    .map((match) => asRecord(match))
    .filter((match): match is Record<string, unknown> => match !== null)
    .map((match) => ({
      path: asString(match.path) ?? "",
      line: asNumber(match.line),
      content: asString(match.content) ?? "",
    }))
    .filter((match) => match.path.length > 0);

  return {
    ok: true,
    target: normalizeTarget(target),
    path: normalizedPath,
    query: query.trim(),
    matches,
    count: asNumber(record.count) ?? matches.length,
    truncated: asBoolean(record.truncated) ?? false,
  };
}

export function normalizeFilesWrite(payload: unknown, target: string, path: string): FilesWritePayload | FilesErrorPayload {
  const normalizedPath = normalizePath(path, detectPathStyle(path));
  const record = asRecord(payload);
  if (!record || record.ok !== true) {
    return {
      ok: false,
      target: normalizeTarget(target),
      path: normalizedPath,
      error: asString(record?.error) ?? `Failed to write ${normalizedPath}`,
    };
  }
  return {
    ok: true,
    target: normalizeTarget(target),
    path: normalizePath(asString(record.path) ?? normalizedPath, detectPathStyle(asString(record.path) ?? normalizedPath)),
    size: asNumber(record.size),
  };
}

export function normalizeFilesDelete(payload: unknown, target: string, path: string): FilesDeletePayload | FilesErrorPayload {
  const normalizedPath = normalizePath(path, detectPathStyle(path));
  const record = asRecord(payload);
  if (!record || record.ok !== true) {
    return {
      ok: false,
      target: normalizeTarget(target),
      path: normalizedPath,
      error: asString(record?.error) ?? `Failed to delete ${normalizedPath}`,
    };
  }
  return {
    ok: true,
    target: normalizeTarget(target),
    path: normalizePath(asString(record.path) ?? normalizedPath, detectPathStyle(asString(record.path) ?? normalizedPath)),
  };
}
