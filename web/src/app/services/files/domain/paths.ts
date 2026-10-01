import type { FilesPathStyle } from "./models";

export function normalizeTarget(target: string | null | undefined): string {
  const value = String(target ?? "").trim();
  return value.length > 0 ? value : "gsv";
}

type FileRequestValue = string | number | boolean | null | undefined;
type FileRequestArgs = Record<string, FileRequestValue>;

export function targetArgs(target: string, args: FileRequestArgs): FileRequestArgs {
  const normalizedTarget = normalizeTarget(target);
  return normalizedTarget === "gsv" ? args : { ...args, target: normalizedTarget };
}

type FilePathRoot = { root: string; rest: string };

// Paths belong to the selected target, independently of the browser's OS.
function splitRoot(input: string): FilePathRoot {
  let raw = input.replaceAll("\\", "/").trim();
  raw = raw.replace(/^\/\/\?\/UNC\//i, "//").replace(/^\/\/\?\/(?=[a-z]:\/)/i, "");
  const drive = /^([a-z]:)\//i.exec(raw);
  if (drive) return { root: `${drive[1]}/`, rest: raw.slice(3) };
  const unc = /^\/\/([^/]+)\/([^/]+)(?:\/|$)/.exec(raw);
  if (unc) return { root: `//${unc[1]}/${unc[2]}/`, rest: raw.slice(unc[0].length) };
  if (raw.startsWith("/")) return { root: "/", rest: raw.slice(1) };
  return { root: "", rest: raw };
}

export function detectPathStyle(path: string | null | undefined): FilesPathStyle {
  return splitRoot(String(path ?? "")).root ? "absolute" : "relative";
}

export function normalizePath(
  input: string | null | undefined,
  style: FilesPathStyle = detectPathStyle(input),
): string {
  const { root, rest } = splitRoot(String(input ?? ""));
  const normalized: string[] = [];
  for (const part of rest.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") normalized.pop();
    else normalized.push(part);
  }
  const prefix = root || (style === "absolute" ? "/" : "");
  return `${prefix}${normalized.join("/")}` || ".";
}

export function parentPath(
  path: string | null | undefined,
  style: FilesPathStyle = detectPathStyle(path),
): string {
  const { root, rest } = splitRoot(normalizePath(path, style));
  const parts = rest.split("/").filter(Boolean);
  parts.pop();
  return `${root}${parts.join("/")}` || ".";
}

export function resolvePath(
  input: string | null | undefined,
  cwd: string | null | undefined,
  style: FilesPathStyle = detectPathStyle(cwd),
): string {
  const raw = String(input ?? "").trim();
  const base = normalizePath(cwd, style);
  if (!raw) return base;
  const inputRoot = splitRoot(raw).root;
  const baseRoot = splitRoot(base).root;
  if (inputRoot === "/" && /^[a-z]:\/$/i.test(baseRoot)) {
    return normalizePath(`${baseRoot}${splitRoot(raw).rest}`, "absolute");
  }
  if (inputRoot) return normalizePath(raw, "absolute");
  // Windows drive-relative paths must not be appended to a different drive.
  if (/^[a-z]:/i.test(raw)) {
    const drive = raw.slice(0, 2);
    const directory = base.slice(0, 2).toLowerCase() === drive.toLowerCase() ? base : `${drive}/`;
    return normalizePath(`${directory}/${raw.slice(2)}`, "absolute");
  }
  return normalizePath(`${base === "." ? "" : `${base}/`}${raw}`, style);
}

export function childPath(parent: string, child: string): string {
  return resolvePath(child, parent, detectPathStyle(parent));
}
