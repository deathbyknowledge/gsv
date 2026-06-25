import type { FilesPathStyle } from "./models";

export function normalizeTarget(target: string | null | undefined): string {
  const value = String(target ?? "").trim();
  return value.length > 0 ? value : "gsv";
}

export function targetArgs(target: string, args: Record<string, unknown>): Record<string, unknown> {
  const normalizedTarget = normalizeTarget(target);
  return normalizedTarget === "gsv" ? args : { ...args, target: normalizedTarget };
}

export function detectPathStyle(path: string | null | undefined): FilesPathStyle {
  return String(path ?? "").trim().startsWith("/") ? "absolute" : "relative";
}

export function normalizePath(
  input: string | null | undefined,
  style: FilesPathStyle = detectPathStyle(input),
): string {
  const raw = String(input ?? "").replaceAll("\\", "/").trim();
  const normalized: string[] = [];

  for (const part of raw.split("/")) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      normalized.pop();
      continue;
    }
    normalized.push(part);
  }

  if (style === "absolute") {
    return normalized.length > 0 ? `/${normalized.join("/")}` : "/";
  }
  return normalized.length > 0 ? normalized.join("/") : ".";
}

export function parentPath(
  path: string | null | undefined,
  style: FilesPathStyle = detectPathStyle(path),
): string {
  const normalized = normalizePath(path, style);
  if (style === "absolute") {
    if (normalized === "/") {
      return "/";
    }
    const parts = normalized.split("/").filter(Boolean);
    parts.pop();
    return parts.length > 0 ? `/${parts.join("/")}` : "/";
  }

  if (normalized === ".") {
    return ".";
  }

  const parts = normalized.split("/").filter(Boolean);
  parts.pop();
  return parts.length > 0 ? parts.join("/") : ".";
}

export function resolvePath(
  input: string | null | undefined,
  cwd: string | null | undefined,
  style: FilesPathStyle = detectPathStyle(cwd),
): string {
  const raw = String(input ?? "").trim();
  if (!raw) {
    return normalizePath(cwd, style);
  }
  if (raw.startsWith("/")) {
    return normalizePath(raw, "absolute");
  }

  const base = normalizePath(cwd, style);
  if (style === "absolute") {
    const prefix = base === "/" ? "/" : `${base}/`;
    return normalizePath(`${prefix}${raw}`, "absolute");
  }

  const prefix = base === "." ? "" : `${base}/`;
  return normalizePath(`${prefix}${raw}`, "relative");
}

export function childPath(parent: string, child: string): string {
  const style = detectPathStyle(parent);
  return resolvePath(child, parent, style);
}
