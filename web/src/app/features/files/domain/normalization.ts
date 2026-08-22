import type {
  FilesContentItem,
  FilesDeletePayload,
  FilesDirectoryEntry,
  FilesErrorPayload,
  FilesReadPayload,
  FilesSearchMatch,
  FilesSearchPayload,
  FilesTarget,
  FilesWritePayload,
} from "./models";
import { z } from "zod";
import { childPath, detectPathStyle, normalizePath, normalizeTarget, parentPath } from "./paths";

type FilesWireValue = string | number | boolean | null | FilesWireValue[] | FilesWireRecord;
type FilesWireRecord = { [key: string]: FilesWireValue };
const filesWireValueSchema: z.ZodType<FilesWireValue> = z.lazy(() => z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(filesWireValueSchema),
  z.record(z.string(), filesWireValueSchema),
]));
const filesPayloadSchema = z.union([filesWireValueSchema, z.array(filesWireValueSchema)]);
type FilesRpcPayload = z.input<typeof filesPayloadSchema>;

function parseFilesPayload(value: FilesRpcPayload): FilesWireValue | FilesWireValue[] {
  return filesPayloadSchema.parse(value);
}

function asRecord(value: FilesWireValue | FilesWireValue[]): FilesWireRecord | null {
  const parsed = z.record(z.string(), filesWireValueSchema).safeParse(value);
  return parsed.success ? parsed.data : null;
}

function asString(value: FilesWireValue | undefined): string | null {
  const parsed = z.string().safeParse(value);
  return parsed.success ? parsed.data : null;
}

function asNumber(value: FilesWireValue | undefined): number | null {
  const parsed = z.number().finite().safeParse(value);
  return parsed.success ? parsed.data : null;
}

function asBoolean(value: FilesWireValue | undefined): boolean | null {
  const parsed = z.boolean().safeParse(value);
  return parsed.success ? parsed.data : null;
}

function asStringArray(value: FilesWireValue | undefined): string[] {
  const parsed = z.array(z.string()).safeParse(value);
  return parsed.success ? parsed.data : [];
}

function decodeNumberedText(content: string): string {
  return content
    .split("\n")
    .map((line) => line.replace(/^\s*\d+\t/, ""))
    .join("\n");
}

function normalizeContent(content: FilesWireValue | undefined): string | FilesContentItem[] {
  const text = z.string().safeParse(content);
  if (text.success) return decodeNumberedText(text.data);
  const items = z.array(filesWireValueSchema).safeParse(content);
  if (!items.success) return "";
  return items.data
    .map((item) => asRecord(item))
    .filter((item): item is FilesWireRecord => item !== null)
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

export function normalizeFilesTargets(payload: FilesRpcPayload): FilesTarget[] {
  const parsed = parseFilesPayload(payload);
  const record = asRecord(parsed);
  const rawDevices = Array.isArray(parsed) ? parsed : Array.isArray(record?.devices) ? record.devices : [];
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

export function normalizeFilesRead(payload: FilesRpcPayload, target: string, requestedPath: string): FilesReadPayload | FilesErrorPayload {
  const normalizedTarget = normalizeTarget(target);
  const record = asRecord(parseFilesPayload(payload));
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
  payload: FilesRpcPayload,
  target: string,
  path: string,
  query: string,
): FilesSearchPayload | FilesErrorPayload {
  const normalizedPath = normalizePath(path, detectPathStyle(path));
  const record = asRecord(parseFilesPayload(payload));
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
    .filter((match): match is FilesWireRecord => match !== null)
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

export function normalizeFilesWrite(payload: FilesRpcPayload, target: string, path: string): FilesWritePayload | FilesErrorPayload {
  const normalizedPath = normalizePath(path, detectPathStyle(path));
  const record = asRecord(parseFilesPayload(payload));
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

export function normalizeFilesDelete(payload: FilesRpcPayload, target: string, path: string): FilesDeletePayload | FilesErrorPayload {
  const normalizedPath = normalizePath(path, detectPathStyle(path));
  const record = asRecord(parseFilesPayload(payload));
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
