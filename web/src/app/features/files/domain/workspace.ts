import type { FilesTarget } from "./models";
import { detectPathStyle, normalizePath, parentPath } from "./paths";

export type FilesBrowserTab = {
  id: string;
  kind: "browser";
  targetId: string;
  path: string;
  commandInput: string;
  commandInputKey: number;
  searchQuery: string;
};

export type FilesFileTab = {
  id: string;
  kind: "file";
  targetId: string;
  path: string;
};

export type FilesWorkspaceTab = FilesBrowserTab | FilesFileTab;

export function browserTabId(targetId: string): string {
  return `browser:${targetId}`;
}

export function fileTabId(targetId: string, path: string): string {
  return `file:${targetId}:${normalizePath(path, detectPathStyle(path))}`;
}

export function createBrowserTab(targetId: string, path = "."): FilesBrowserTab {
  const normalizedPath = normalizePath(path, detectPathStyle(path));
  return {
    id: browserTabId(targetId),
    kind: "browser",
    targetId,
    path: normalizedPath,
    commandInput: "",
    commandInputKey: 0,
    searchQuery: "",
  };
}

export function createFileTab(targetId: string, path: string): FilesFileTab {
  const normalizedPath = normalizePath(path, detectPathStyle(path));
  return {
    id: fileTabId(targetId, normalizedPath),
    kind: "file",
    targetId,
    path: normalizedPath,
  };
}

export function pathBasename(path: string): string {
  const normalized = normalizePath(path, detectPathStyle(path));
  if (normalized === "." || normalized === "/") {
    return "root";
  }
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
}

export function pathParent(path: string): string {
  return parentPath(path, detectPathStyle(path));
}

export function targetDisplayName(target: FilesTarget | null | undefined, fallback: string): string {
  return target?.label?.trim() || target?.id || fallback;
}

export function tabLabel(tab: FilesWorkspaceTab, target: FilesTarget | null | undefined, dirty = false): string {
  if (tab.kind === "browser") {
    const basename = pathBasename(tab.path);
    return basename === "root" ? targetDisplayName(target, tab.targetId) : basename;
  }
  return `${pathBasename(tab.path)}${dirty ? " *" : ""}`;
}

export function targetTone(target: FilesTarget): "online" | "idle" {
  return target.online ? "online" : "idle";
}
