import type { FsDeleteArgs, FsDeleteResult } from "../syscalls/delete";
import type { FsEditArgs, FsEditResult } from "../syscalls/edit";
import type { FsReadArgs, FsReadResult } from "../syscalls/read";
import type { FsWriteArgs, FsWriteResult } from "../syscalls/write";
import type { ProcessIdentity } from "../syscalls/system";

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

/* R2 filesystem hierarchy:
  / -> root
  /root/ -> root home directory
  /home/<user>/ -> user home directory (default workspace)
  /home/<user>/sessions/ -> session storage
  /etc/* -> config files (system-owned)
  /media/* -> media files
*/

export type FsChmodArgs = { path: string; mode: string };
export type FsChmodResult = { ok: boolean; error?: string; path?: string };

export type FsChownArgs = { path: string; uid: number; gid: number };
export type FsChownResult = { ok: boolean; error?: string; path?: string };

export class R2FS {
  private bucket: R2Bucket;
  private identity: ProcessIdentity;
  private cwd: string;

  constructor(bucket: R2Bucket, identity: ProcessIdentity, cwd?: string) {
    this.bucket = bucket;
    this.identity = identity;
    this.cwd = cwd ?? identity.home;
  }

  normalizePath(path: string): string {
    let resolved = path;

    if (resolved === "~" || resolved.startsWith("~/")) {
      resolved =
        resolved === "~"
          ? this.identity.home
          : this.identity.home.replace(/\/+$/, "") + resolved.slice(1);
    }

    if (!resolved.startsWith("/")) {
      const base = this.cwd.endsWith("/") ? this.cwd : this.cwd + "/";
      resolved = base + resolved;
    }

    const segments: string[] = [];
    for (const seg of resolved.split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") {
        segments.pop();
      } else {
        segments.push(seg);
      }
    }

    return "/" + segments.join("/");
  }

  async read(args: FsReadArgs): Promise<FsReadResult> {
    const p = this.normalizePath(args.path);
    const object = await this.bucket.get(p);

    if (object) {
      if (!this.canRead(object)) {
        return { ok: false, error: `Permission denied: ${p}` };
      }

      const contentType =
        object.httpMetadata?.contentType || "application/octet-stream";

      if (contentType.startsWith("image/")) {
        return this.readImage(object, p, contentType);
      }

      if (!this.isTextType(contentType)) {
        return {
          ok: false,
          error: `Binary file (${contentType}, ${formatSize(object.size)}) — not readable as text`,
        };
      }

      return this.readText(object, p, args.offset, args.limit);
    }

    return this.listDirectory(p);
  }

  async write(args: FsWriteArgs): Promise<FsWriteResult> {
    const p = this.normalizePath(args.path);

    const existing = await this.bucket.head(p);
    if (existing && !this.checkMode(existing, WRITE_BIT)) {
      return { ok: false, error: `Permission denied: ${p}` };
    }

    await this.bucket.put(p, args.content, {
      httpMetadata: { contentType: inferContentType(p) },
      customMetadata: {
        uid: String(this.identity.uid),
        gid: String(this.identity.gid),
        mode: "644",
      },
    });

    return { ok: true, path: p, size: args.content.length };
  }

  async edit(args: FsEditArgs): Promise<FsEditResult> {
    const p = this.normalizePath(args.path);
    const object = await this.bucket.get(p);

    if (!object) {
      return { ok: false, error: `File not found: ${p}` };
    }

    if (!this.checkMode(object, WRITE_BIT)) {
      return { ok: false, error: `Permission denied: ${p}` };
    }

    const contentType =
      object.httpMetadata?.contentType || "application/octet-stream";

    if (!this.isTextType(contentType)) {
      return {
        ok: false,
        error: `Cannot edit binary file (${contentType}, ${formatSize(object.size)})`,
      };
    }

    const content = await object.text();

    const count = content.split(args.oldString).length - 1;
    if (count === 0) {
      return { ok: false, error: `oldString not found in ${p}` };
    }
    if (!args.replaceAll && count > 1) {
      return {
        ok: false,
        error: `oldString found ${count} times in ${p}. Use replaceAll or provide more context.`,
      };
    }

    const updated = args.replaceAll
      ? content.replaceAll(args.oldString, args.newString)
      : content.replace(args.oldString, args.newString);

    await this.bucket.put(p, updated, {
      httpMetadata: object.httpMetadata,
      customMetadata: object.customMetadata,
    });

    return { ok: true, path: p, replacements: args.replaceAll ? count : 1 };
  }

  async delete(args: FsDeleteArgs): Promise<FsDeleteResult> {
    const p = this.normalizePath(args.path);

    const existing = await this.bucket.head(p);
    if (!existing) {
      return { ok: false, error: `File not found: ${p}` };
    }

    if (!this.checkMode(existing, WRITE_BIT)) {
      return { ok: false, error: `Permission denied: ${p}` };
    }

    await this.bucket.delete(p);

    return { ok: true, path: p };
  }

  async chmod(args: FsChmodArgs): Promise<FsChmodResult> {
    const p = this.normalizePath(args.path);

    if (!isValidMode(args.mode)) {
      return { ok: false, error: `Invalid mode: ${args.mode}` };
    }

    const object = await this.bucket.get(p);
    if (!object) {
      return { ok: false, error: `File not found: ${p}` };
    }

    const fileUid = parseInt(object.customMetadata?.uid ?? "-1", 10);
    if (this.identity.uid !== 0 && this.identity.uid !== fileUid) {
      return { ok: false, error: `Permission denied: only owner or root can chmod` };
    }

    const content = await object.arrayBuffer();
    await this.bucket.put(p, content, {
      httpMetadata: object.httpMetadata,
      customMetadata: { ...object.customMetadata, mode: args.mode },
    });

    return { ok: true, path: p };
  }

  async chown(args: FsChownArgs): Promise<FsChownResult> {
    const p = this.normalizePath(args.path);

    if (this.identity.uid !== 0) {
      return { ok: false, error: `Permission denied: only root can chown` };
    }

    const object = await this.bucket.get(p);
    if (!object) {
      return { ok: false, error: `File not found: ${p}` };
    }

    const content = await object.arrayBuffer();
    await this.bucket.put(p, content, {
      httpMetadata: object.httpMetadata,
      customMetadata: {
        ...object.customMetadata,
        uid: String(args.uid),
        gid: String(args.gid),
      },
    });

    return { ok: true, path: p };
  }

  private canRead(object: R2Object | R2ObjectBody): boolean {
    return this.checkMode(object, READ_BIT);
  }

  private checkMode(object: R2Object | R2ObjectBody, bit: number): boolean {
    if (this.identity.uid === 0) return true;

    const meta = object.customMetadata;
    const mode = meta?.mode ?? "644";
    const fileUid = parseInt(meta?.uid ?? "-1", 10);
    const fileGid = parseInt(meta?.gid ?? "-1", 10);

    const digits = parseMode(mode);

    if (this.identity.uid === fileUid) {
      return (digits.owner & bit) !== 0;
    }
    if (this.identity.gids.includes(fileGid)) {
      return (digits.group & bit) !== 0;
    }
    return (digits.other & bit) !== 0;
  }


  private async readText(
    object: R2ObjectBody,
    path: string,
    offset?: number,
    limit?: number,
  ): Promise<FsReadResult> {
    const text = await object.text();
    const allLines = text.split("\n");
    const start = offset ?? 0;
    const count = limit ?? allLines.length;

    const selected = allLines.slice(start, start + count);
    const numbered = selected
      .map((line, i) => `${String(start + i + 1).padStart(6)}\t${line}`)
      .join("\n");

    return {
      ok: true,
      content: numbered,
      path,
      lines: selected.length,
      size: object.size,
    };
  }

  private async readImage(
    object: R2ObjectBody,
    path: string,
    mimeType: string,
  ): Promise<FsReadResult> {
    if (object.size > MAX_IMAGE_BYTES) {
      return {
        ok: false,
        error: `Image too large (${formatSize(object.size)}, max ${formatSize(MAX_IMAGE_BYTES)})`,
      };
    }

    const buf = await object.arrayBuffer();
    const base64 = uint8ArrayToBase64(new Uint8Array(buf));

    return {
      ok: true,
      content: [
        {
          type: "text",
          text: `Read image ${path} [${mimeType}, ${formatSize(object.size)}]`,
        },
        { type: "image", data: base64, mimeType },
      ],
      path,
      size: object.size,
    };
  }

  private async listDirectory(path: string): Promise<FsReadResult> {
    const prefix = path.endsWith("/") ? path : `${path}/`;
    const listed = await this.bucket.list({ prefix, delimiter: "/" });

    const files: string[] = [];
    const directories: string[] = [];

    for (const obj of listed.objects) {
      const name = obj.key.slice(prefix.length);
      if (name) files.push(name);
    }
    for (const dp of listed.delimitedPrefixes) {
      const name = dp.slice(prefix.length).replace(/\/+$/, "");
      if (name) directories.push(name);
    }

    if (files.length === 0 && directories.length === 0) {
      return { ok: false, error: `Not found: ${path}` };
    }

    return { ok: true, path, files, directories };
  }

  private isTextType(contentType: string): boolean {
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
}

const READ_BIT = 4;
const WRITE_BIT = 2;

type ModeDigits = { owner: number; group: number; other: number };

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


function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function inferContentType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    md: "text/markdown",
    json: "application/json",
    yaml: "application/yaml",
    yml: "application/yaml",
    xml: "application/xml",
    toml: "application/toml",
    js: "application/javascript",
    ts: "application/typescript",
    html: "text/html",
    css: "text/css",
    txt: "text/plain",
    csv: "text/csv",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
  };
  return (ext && map[ext]) || "text/plain";
}
