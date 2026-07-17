export const PROCESS_MEDIA_ROOT = "/var/media";
const ARCHIVED_MEDIA_BASENAME = /^archived-media:[0-9a-f]{64}$/;

export type ParsedProcessMediaPath =
  | { kind: "root" }
  | { kind: "uid"; uid: number }
  | { kind: "process"; uid: number; pid: string }
  | { kind: "file"; uid: number; pid: string; key: string };

export function processMediaPrefix(uid: number, pid: string): string {
  return `var/media/${uid}/${pid}/`;
}

export function agentArchiveMediaPrefix(home: string): string {
  const homeKey = home.replace(/^\/+/, "").replace(/\/+$/, "");
  return `${homeKey}/.gsv/media/`;
}

export function agentArchiveMediaPath(home: string, key: string): string | null {
  const prefix = agentArchiveMediaPrefix(home);
  const basename = key.startsWith(prefix) ? key.slice(prefix.length) : "";
  return ARCHIVED_MEDIA_BASENAME.test(basename) ? `/${key}` : null;
}

/** Convert a physical process-media R2 key to its stable filesystem path. */
export function processMediaPath(key: string): string | null {
  const path = `/${key}`;
  const parsed = parseProcessMediaPath(path);
  return parsed?.kind === "file" && parsed.key === key ? path : null;
}

export function isProcessMediaPath(path: string): boolean {
  return path === PROCESS_MEDIA_ROOT || path.startsWith(`${PROCESS_MEDIA_ROOT}/`);
}

export function parseProcessMediaPath(path: string): ParsedProcessMediaPath | null {
  if (path === PROCESS_MEDIA_ROOT) return { kind: "root" };
  if (!path.startsWith(`${PROCESS_MEDIA_ROOT}/`)) return null;

  const segments = path.slice(PROCESS_MEDIA_ROOT.length + 1).split("/");
  if (segments.length < 1 || segments.length > 3) return null;
  const uid = Number(segments[0]);
  if (!Number.isSafeInteger(uid) || uid < 0 || String(uid) !== segments[0]) return null;
  if (segments.length === 1) return { kind: "uid", uid };

  const pid = segments[1];
  if (!isSafeSegment(pid)) return null;
  if (segments.length === 2) return { kind: "process", uid, pid };

  const basename = segments[2];
  if (!isSafeSegment(basename)) return null;
  return {
    kind: "file",
    uid,
    pid,
    key: processMediaPrefix(uid, pid) + basename,
  };
}

function isSafeSegment(value: string): boolean {
  return value.length > 0 && value !== "." && value !== ".." && !value.includes("\0");
}
