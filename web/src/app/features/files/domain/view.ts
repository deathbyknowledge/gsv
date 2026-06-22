import type {
  FilesContentItem,
  FilesDirectoryEntry,
  FilesFilePayload,
  FilesPathStyle,
  FilesSearchMatch,
  FilesTarget,
} from "./models";
import { detectPathStyle, normalizePath, resolvePath } from "./paths";

export type FilesPathCrumb = {
  label: string;
  path: string;
};

export type FilesImagePreview = {
  src: string;
  mimeType: string;
};

export function chooseInitialTarget(targets: readonly FilesTarget[]): string | null {
  return targets.find((target) => target.online)?.id ?? targets[0]?.id ?? null;
}

export function describeTarget(target: FilesTarget): string {
  return [target.platform, target.ownerUsername, target.description, target.id].filter(Boolean).join(" · ");
}

export function formatTargetOption(target: FilesTarget): string {
  const label = target.label || target.id;
  return `${label} · ${target.online ? "ONLINE" : "OFFLINE"}`;
}

export function sortDirectoryEntries(entries: readonly FilesDirectoryEntry[]): FilesDirectoryEntry[] {
  return [...entries].sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === "directory" ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
}

export function buildPathCrumbs(path: string): FilesPathCrumb[] {
  const style = detectPathStyle(path);
  const normalized = normalizePath(path, style);
  const parts = normalized.split("/").filter(Boolean);
  const rootPath = style === "absolute" ? "/" : ".";
  const crumbs: FilesPathCrumb[] = [{ label: "ROOT", path: rootPath }];

  parts.forEach((part, index) => {
    const nextPath = style === "absolute"
      ? `/${parts.slice(0, index + 1).join("/")}`
      : parts.slice(0, index + 1).join("/");
    crumbs.push({ label: part, path: nextPath });
  });

  return crumbs;
}

export function pathRoot(path: string, style: FilesPathStyle = detectPathStyle(path)): string {
  return style === "absolute" ? "/" : ".";
}

export function resolveEnteredPath(input: string, currentPath: string): string {
  return resolvePath(input, currentPath, detectPathStyle(currentPath));
}

export function formatBytes(size: number | null): string {
  if (size === null) {
    return "";
  }
  if (size < 1024) {
    return `${size} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

export function formatFileStats(file: FilesFilePayload): string {
  return [
    formatBytes(file.size),
    file.lines === null ? "" : `${file.lines} ${file.lines === 1 ? "line" : "lines"}`,
  ].filter(Boolean).join(" · ");
}

export function textFromContent(content: string | FilesContentItem[]): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .filter((item): item is Extract<FilesContentItem, { type: "text" }> => item.type === "text")
    .map((item) => item.text ?? "")
    .filter((text) => text.length > 0)
    .join("\n\n");
}

export function imagePreviewsFromContent(content: string | FilesContentItem[]): FilesImagePreview[] {
  if (typeof content === "string") {
    return [];
  }
  return content
    .filter((item): item is Extract<FilesContentItem, { type: "image" }> => item.type === "image")
    .map((item) => {
      const data = item.data ?? "";
      const mimeType = item.mimeType ?? "image/png";
      const src = data.startsWith("data:") ? data : `data:${mimeType};base64,${data}`;
      return { src, mimeType };
    })
    .filter((preview) => preview.src.length > 0);
}

export function formatSearchMatchLine(match: FilesSearchMatch): string {
  return match.line === null ? "MATCH" : `LINE ${match.line}`;
}
