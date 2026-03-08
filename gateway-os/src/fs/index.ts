import type { FsDeleteArgs, FsDeleteResult } from "../syscalls/delete";
import type { FsEditArgs, FsEditResult } from "../syscalls/edit";
import type { FsReadArgs, FsReadResult } from "../syscalls/read";
import type { FsWriteArgs, FsWriteResult } from "../syscalls/write";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/* What it looks like today:
  /agents/main/ -> AGENTS.md, SOUL.md, IDENTITY.md, USER.md, MEMORY.md, TOOLS.md, HEARTBEAT.md, BOOTSTRAP.md
  /agents/main/memories/ -> memory/YYYY-MM-DD.md
  /agents/main/sessions/ -> <sessionId>.jsonl.gz
*/

/* What the R2 filesystem hierarchy should look like:
  / -> root
  /home/<user>/ -> user home directory (default workspace)
  /home/<user>/sessions/ -> session storage
  /etc/* -> config files (system-owned, read-only)
  /media/* -> media files (configurable whether they are kept or not)
*/




export class R2FS {
  private bucket: R2Bucket;
  private cwd: string;
  private home: string;
  private user: string;

  constructor(bucket: R2Bucket, user: string) {
    this.bucket = bucket;
    this.user = user;
    this.cwd = `/home/${user}/`;
    this.home = `/home/${user}/`;
  }

  normalizePath(path: string): string {
    let resolved = path;

    if (resolved === "~" || resolved.startsWith("~/")) {
      resolved =
        resolved === "~"
          ? this.home
          : this.home.replace(/\/+$/, "") + resolved.slice(1);
    }

    if (!resolved.startsWith("/")) {
      const cwd = this.cwd.endsWith("/") ? this.cwd : this.cwd + "/";
      resolved = cwd + resolved;
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

  private canRead(object: R2Object | R2ObjectBody): boolean {
    const owner = object.customMetadata?.owner;
    const perms = object.customMetadata?.permissions;

    if (owner === this.user || owner === "public") return true;
    if (perms === "public-read") return true;
    if (owner === "system") {
      // system files are readable but not writable
      return true;
    }
    return false;
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

  async write(args: FsWriteArgs): Promise<FsWriteResult> {
    const p = this.normalizePath(args.path);

    const existing = await this.bucket.head(p);
    if (existing && !this.canWrite(existing)) {
      return { ok: false, error: `Permission denied: ${p}` };
    }

    await this.bucket.put(p, args.content, {
      httpMetadata: { contentType: inferContentType(p) },
      customMetadata: { owner: this.user },
    });

    return { ok: true, path: p, size: args.content.length };
  }

  async edit(args: FsEditArgs): Promise<FsEditResult> {
    const p = this.normalizePath(args.path);
    const object = await this.bucket.get(p);

    if (!object) {
      return { ok: false, error: `File not found: ${p}` };
    }

    if (!this.canWrite(object)) {
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

    if (!this.canWrite(existing)) {
      return { ok: false, error: `Permission denied: ${p}` };
    }

    await this.bucket.delete(p);

    return { ok: true, path: p };
  }

  private canWrite(object: R2Object | R2ObjectBody): boolean {
    return object.customMetadata?.owner === this.user;
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

