import type { ProcessIdentity } from "@gsv/protocol/syscalls/system";
import { GsvFs } from "./fs/gsv-fs";
import { inferContentType, normalizePath } from "./fs/utils";
import type { OpenFileOptions, OpenFileRangeRequest, OpenFileResult } from "./fs/mount";

export const PUBLIC_ASSET_ROUTE_PREFIX = "/public/";
export const PUBLIC_ASSET_FS_ROOT = "/public";

const PUBLIC_ASSET_IDENTITY: ProcessIdentity = {
  uid: 0,
  gid: 0,
  gids: [0],
  username: "root",
  home: "/root",
  cwd: "/root",
};

const DOCUMENT_CONTENT_TYPES = new Set([
  "application/xhtml+xml",
  "image/svg+xml",
  "text/html",
]);

export type PublicAssetMatch = {
  fsPath: string;
};

export type PublicAssetFileSystem = {
  realpath(path: string): Promise<string>;
  openFile(path: string, options?: OpenFileOptions): Promise<OpenFileResult>;
};

export function matchPublicAssetPath(pathname: string): PublicAssetMatch | null {
  if (!pathname.startsWith(PUBLIC_ASSET_ROUTE_PREFIX)) {
    return null;
  }

  const segments: string[] = [];
  for (const rawSegment of pathname.slice(PUBLIC_ASSET_ROUTE_PREFIX.length).split("/")) {
    if (!rawSegment) {
      continue;
    }

    let segment: string;
    try {
      segment = decodeURIComponent(rawSegment);
    } catch {
      return null;
    }

    if (
      segment === "." ||
      segment === ".." ||
      segment.includes("/") ||
      segment.includes("\0")
    ) {
      return null;
    }
    segments.push(segment);
  }

  if (segments.length === 0) {
    return null;
  }

  const fsPath = normalizePath(`${PUBLIC_ASSET_FS_ROOT}/${segments.join("/")}`);
  return isPublicAssetFsPath(fsPath) ? { fsPath } : null;
}

export function createPublicAssetFileSystem(env: Pick<Env, "STORAGE">): PublicAssetFileSystem {
  return new GsvFs(env.STORAGE, PUBLIC_ASSET_IDENTITY);
}

export async function ensurePublicAssetStorageLayout(env: Pick<Env, "STORAGE">): Promise<void> {
  const marker = "public/.dir";
  if (await env.STORAGE.head(marker)) {
    return;
  }

  await env.STORAGE.put(marker, new ArrayBuffer(0), {
    customMetadata: {
      uid: String(PUBLIC_ASSET_IDENTITY.uid),
      gid: String(PUBLIC_ASSET_IDENTITY.gid),
      mode: "755",
      dirmarker: "1",
    },
  });
}

export async function servePublicAssetRequest(
  request: Request,
  fs: PublicAssetFileSystem,
  match: PublicAssetMatch,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { allow: "GET, HEAD" },
    });
  }

  let resolvedPath: string;
  try {
    resolvedPath = await fs.realpath(match.fsPath);
    if (!isPublicAssetFsPath(resolvedPath)) {
      return new Response("Not Found", { status: 404 });
    }
  } catch {
    return new Response("Not Found", { status: 404 });
  }

  try {
    const options = openFileOptionsFromRequest(request);
    if (!options) {
      return rangeNotSatisfiableResponse();
    }

    const file = await fs.openFile(resolvedPath, options);
    if (
      file.status !== 304 &&
      file.status !== 412 &&
      options.range &&
      isUnsatisfiableRange(options.range, file.totalSize)
    ) {
      return rangeNotSatisfiableResponse(file.totalSize);
    }
    const headers = publicAssetHeaders(resolvedPath, file);
    if (file.status === 304 || file.status === 412) {
      headers.delete("content-length");
      return new Response(null, { status: file.status, headers });
    }
    if (request.method === "HEAD") {
      return new Response(null, { status: file.status, headers });
    }
    return new Response(file.body ?? null, { status: file.status, headers });
  } catch {
    return new Response("Not Found", { status: 404 });
  }
}

function publicAssetHeaders(path: string, file: OpenFileResult): Headers {
  const headers = new Headers();
  file.writeHttpMetadata?.(headers);

  const contentType = headers.get("content-type") || file.contentType || inferContentType(path);
  headers.set("access-control-allow-origin", "*");
  headers.set("content-type", contentType);
  headers.set("last-modified", file.mtime.toUTCString());
  headers.set("x-content-type-options", "nosniff");
  if (file.etag) {
    headers.set("etag", file.etag);
  }
  if (!headers.has("cache-control") || path.startsWith(`${PUBLIC_ASSET_FS_ROOT}/gsv/assets/`)) {
    headers.set("cache-control", publicAssetCacheControl(path));
  }
  if (file.status !== 304 && file.status !== 412) {
    headers.set("content-length", String(file.size));
  }
  if (file.range) {
    headers.set("accept-ranges", "bytes");
    headers.set(
      "content-range",
      `bytes ${file.range.offset}-${file.range.offset + file.range.length - 1}/${file.range.total}`,
    );
  }

  if (DOCUMENT_CONTENT_TYPES.has(contentType.split(";")[0].trim().toLowerCase())) {
    headers.set("content-security-policy", "sandbox");
  }

  return headers;
}

function rangeNotSatisfiableResponse(totalSize?: number): Response {
  const headers = new Headers({ "accept-ranges": "bytes" });
  if (typeof totalSize === "number") {
    headers.set("content-range", `bytes */${totalSize}`);
  }
  return new Response("Range Not Satisfiable", {
    status: 416,
    headers,
  });
}

function isUnsatisfiableRange(range: OpenFileRangeRequest, totalSize: number): boolean {
  if (totalSize <= 0) {
    return true;
  }
  return "offset" in range && range.offset >= totalSize;
}

function publicAssetCacheControl(path: string): string {
  if (path.startsWith(`${PUBLIC_ASSET_FS_ROOT}/gsv/assets/`)) {
    return "public, max-age=31536000, immutable";
  }
  return "public, max-age=300, must-revalidate";
}

function isPublicAssetFsPath(path: string): boolean {
  const normalized = normalizePath(path);
  return normalized.startsWith(`${PUBLIC_ASSET_FS_ROOT}/`);
}

function openFileOptionsFromRequest(request: Request): OpenFileOptions | null {
  const conditions = openFileConditionsFromHeaders(request.headers);
  const range = openFileRangeFromHeaders(request.headers);
  if (range === null) {
    return null;
  }

  return {
    ...(conditions ? { conditions } : {}),
    ...(range ? { range } : {}),
  };
}

function openFileConditionsFromHeaders(headers: Headers): OpenFileOptions["conditions"] | undefined {
  const conditions: NonNullable<OpenFileOptions["conditions"]> = {};
  const ifMatch = firstHttpListValue(headers.get("if-match"));
  const ifNoneMatch = firstHttpListValue(headers.get("if-none-match"));
  const ifUnmodifiedSince = parseHttpDate(headers.get("if-unmodified-since"));
  const ifModifiedSince = parseHttpDate(headers.get("if-modified-since"));

  if (ifMatch) {
    conditions.etagMatches = ifMatch;
  }
  if (ifNoneMatch) {
    conditions.etagDoesNotMatch = ifNoneMatch;
  }
  if (ifUnmodifiedSince) {
    conditions.mtimeBefore = ifUnmodifiedSince;
  }
  if (ifModifiedSince && !ifNoneMatch) {
    conditions.mtimeAfter = ifModifiedSince;
  }

  return Object.keys(conditions).length > 0 ? conditions : undefined;
}

function openFileRangeFromHeaders(headers: Headers): OpenFileRangeRequest | null | undefined {
  const header = headers.get("range");
  if (!header) {
    return undefined;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) {
    return null;
  }

  const startText = match[1];
  const endText = match[2];
  if (!startText && !endText) {
    return null;
  }

  if (!startText) {
    const suffix = Number(endText);
    return Number.isSafeInteger(suffix) && suffix > 0 ? { suffix } : null;
  }

  const offset = Number(startText);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    return null;
  }

  if (!endText) {
    return { offset };
  }

  const end = Number(endText);
  if (!Number.isSafeInteger(end) || end < offset) {
    return null;
  }

  return { offset, length: end - offset + 1 };
}

function firstHttpListValue(value: string | null): string | undefined {
  const first = value?.split(",")[0]?.trim();
  return first || undefined;
}

function parseHttpDate(value: string | null): Date | undefined {
  if (!value) {
    return undefined;
  }

  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time) : undefined;
}
