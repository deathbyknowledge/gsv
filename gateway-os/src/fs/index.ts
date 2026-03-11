/**
 * Filesystem module — re-exports unified GsvFs and utility functions.
 *
 * GsvFs is the single IFileSystem implementation used everywhere:
 * - fs.* syscall handlers (with formatting on top)
 * - Bash shell driver
 * - Any code needing file access
 */

export { GsvFs } from "./gsv-fs";
export type { KernelRefs, ExtendedStat } from "./gsv-fs";

/**
 * Resolve a user-facing path, handling ~ expansion and relative paths.
 * Used by fs.* syscall handlers before passing to GsvFs.
 */
export function resolveUserPath(path: string, home: string, cwd: string): string {
  let resolved = path;

  if (resolved === "~" || resolved.startsWith("~/")) {
    resolved = resolved === "~"
      ? home
      : home.replace(/\/+$/, "") + resolved.slice(1);
  }

  if (!resolved.startsWith("/")) {
    const base = cwd.endsWith("/") ? cwd : cwd + "/";
    resolved = base + resolved;
  }

  return normalizePath(resolved);
}

export function normalizePath(path: string): string {
  const segments: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") segments.pop();
    else segments.push(seg);
  }
  return "/" + segments.join("/");
}


export type ModeDigits = { owner: number; group: number; other: number };

export function parseMode(mode: string): ModeDigits {
  const digits = mode.padStart(3, "0").slice(-3);
  return {
    owner: parseInt(digits[0], 10),
    group: parseInt(digits[1], 10),
    other: parseInt(digits[2], 10),
  };
}

export function isValidMode(mode: string): boolean {
  return /^[0-7]{3,4}$/.test(mode);
}


export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function isTextContentType(contentType: string): boolean {
  const base = contentType.split(";")[0].trim().toLowerCase();
  return (
    base.startsWith("text/") ||
    base === "application/json" ||
    base === "application/yaml" ||
    base === "application/xml" ||
    base === "application/javascript" ||
    base === "application/typescript" ||
    base === "application/toml"
  );
}

export function inferContentType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    md: "text/markdown", json: "application/json", yaml: "application/yaml",
    yml: "application/yaml", xml: "application/xml", toml: "application/toml",
    js: "application/javascript", ts: "application/typescript",
    html: "text/html", css: "text/css", txt: "text/plain", csv: "text/csv",
    sh: "text/x-shellscript", py: "text/x-python",
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  };
  return (ext && map[ext]) || "text/plain";
}
