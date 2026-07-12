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

export function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const output = new Uint8Array(left.length + right.length);
  output.set(left);
  output.set(right, left.length);
  return output;
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

export {
  inferFsContentType as inferContentType,
  isTextContentType,
} from "@humansandmachines/gsv/protocol";
