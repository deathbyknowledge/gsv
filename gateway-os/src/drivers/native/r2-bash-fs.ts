/**
 * R2BashFs — IFileSystem adapter backed by Cloudflare R2.
 *
 * Implements the just-bash IFileSystem interface using R2 as the storage backend.
 * Enforces Unix-style uid/gid/mode permissions via our R2 customMetadata convention.
 *
 * R2 is a flat key-value store, so directories are virtual. A "directory" exists
 * if any object has that prefix. We use trailing-slash marker objects for explicitly
 * created empty directories (mkdir).
 */

import type {
  IFileSystem,
  FsStat,
  FileContent,
  MkdirOptions,
  RmOptions,
  CpOptions,
  BufferEncoding,
} from "just-bash";
import type { ProcessIdentity } from "../../syscalls/system";

const READ_BIT = 4;
const WRITE_BIT = 2;

export class R2BashFs implements IFileSystem {
  private bucket: R2Bucket;
  private identity: ProcessIdentity;

  constructor(bucket: R2Bucket, identity: ProcessIdentity) {
    this.bucket = bucket;
    this.identity = identity;
  }

  async readFile(path: string, _options?: { encoding?: BufferEncoding | null } | BufferEncoding): Promise<string> {
    const key = toKey(path);
    const obj = await this.bucket.get(key);
    if (!obj) throw new Error(`ENOENT: no such file or directory, open '${path}'`);

    if (isDirectoryMarker(obj)) {
      throw new Error(`EISDIR: illegal operation on a directory, read '${path}'`);
    }

    this.assertMode(obj, READ_BIT, path);
    return obj.text();
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const key = toKey(path);
    const obj = await this.bucket.get(key);
    if (!obj) throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    this.assertMode(obj, READ_BIT, path);
    const buf = await obj.arrayBuffer();
    return new Uint8Array(buf);
  }

  async writeFile(path: string, content: FileContent, _options?: { encoding?: BufferEncoding } | BufferEncoding): Promise<void> {
    const key = toKey(path);

    const existing = await this.bucket.head(key);
    if (existing) {
      this.assertMode(existing, WRITE_BIT, path);
    }

    await this.bucket.put(key, content, {
      httpMetadata: { contentType: inferContentType(path) },
      customMetadata: {
        uid: String(this.identity.uid),
        gid: String(this.identity.gid),
        mode: existing?.customMetadata?.mode ?? "644",
      },
    });
  }

  async appendFile(path: string, content: FileContent, _options?: { encoding?: BufferEncoding } | BufferEncoding): Promise<void> {
    const key = toKey(path);
    const existing = await this.bucket.get(key);

    if (existing) {
      this.assertMode(existing, WRITE_BIT, path);
      const old = await existing.text();
      const appended = typeof content === "string" ? old + content : old + new TextDecoder().decode(content);
      await this.bucket.put(key, appended, {
        httpMetadata: existing.httpMetadata,
        customMetadata: existing.customMetadata,
      });
    } else {
      await this.writeFile(path, content);
    }
  }

  async exists(path: string): Promise<boolean> {
    const key = toKey(path);

    const head = await this.bucket.head(key);
    if (head) return true;

    const dirPrefix = key.endsWith("/") ? key : key + "/";
    const listed = await this.bucket.list({ prefix: dirPrefix, limit: 1 });
    return listed.objects.length > 0 || listed.delimitedPrefixes.length > 0;
  }

  async stat(path: string): Promise<FsStat> {
    const key = toKey(path);

    const head = await this.bucket.head(key);
    if (head) {
      if (isDirectoryMarker(head)) {
        return {
          isFile: false,
          isDirectory: true,
          isSymbolicLink: false,
          mode: parseOctalMode(head.customMetadata?.mode ?? "755"),
          size: 0,
          mtime: head.uploaded,
        };
      }
      return {
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
        mode: parseOctalMode(head.customMetadata?.mode ?? "644"),
        size: head.size,
        mtime: head.uploaded,
      };
    }

    const dirPrefix = key.endsWith("/") ? key : key + "/";
    const listed = await this.bucket.list({ prefix: dirPrefix, limit: 1 });
    if (listed.objects.length > 0 || listed.delimitedPrefixes.length > 0) {
      return {
        isFile: false,
        isDirectory: true,
        isSymbolicLink: false,
        mode: 0o755,
        size: 0,
        mtime: new Date(),
      };
    }

    throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
  }

  async lstat(path: string): Promise<FsStat> {
    return this.stat(path);
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    const key = toKey(path);

    if (!options?.recursive) {
      const parentKey = key.split("/").slice(0, -1).join("/");
      if (parentKey) {
        const parentExists = await this.exists("/" + parentKey);
        if (!parentExists) {
          throw new Error(`ENOENT: no such file or directory, mkdir '${path}'`);
        }
      }
    }

    const dirKey = key.endsWith("/") ? key : key + "/";
    const markerKey = dirKey + ".dir";
    const existing = await this.bucket.head(markerKey);
    if (existing && !options?.recursive) {
      throw new Error(`EEXIST: file already exists, mkdir '${path}'`);
    }

    await this.bucket.put(markerKey, "", {
      customMetadata: {
        uid: String(this.identity.uid),
        gid: String(this.identity.gid),
        mode: "755",
        dirmarker: "1",
      },
    });
  }

  async readdir(path: string): Promise<string[]> {
    const key = toKey(path);
    const prefix = key ? key + "/" : "";

    const listed = await this.bucket.list({ prefix, delimiter: "/" });

    const entries: string[] = [];
    for (const obj of listed.objects) {
      const name = obj.key.slice(prefix.length);
      if (name && !name.endsWith("/.dir") && name !== ".dir") entries.push(name);
    }
    for (const dp of listed.delimitedPrefixes) {
      const name = dp.slice(prefix.length).replace(/\/+$/, "");
      if (name) entries.push(name);
    }

    if (entries.length === 0) {
      const dirExists = await this.exists(path);
      if (!dirExists) {
        throw new Error(`ENOENT: no such file or directory, scandir '${path}'`);
      }
    }

    return [...new Set(entries)].sort();
  }

  async readdirWithFileTypes(path: string): Promise<{ name: string; isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean }[]> {
    const names = await this.readdir(path);
    const results: { name: string; isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean }[] = [];

    for (const name of names) {
      const childPath = path.endsWith("/") ? path + name : path + "/" + name;
      try {
        const s = await this.stat(childPath);
        results.push({
          name,
          isFile: s.isFile,
          isDirectory: s.isDirectory,
          isSymbolicLink: s.isSymbolicLink,
        });
      } catch {
        results.push({ name, isFile: true, isDirectory: false, isSymbolicLink: false });
      }
    }

    return results;
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    const key = toKey(path);

    const head = await this.bucket.head(key);
    if (head) {
      this.assertMode(head, WRITE_BIT, path);
      await this.bucket.delete(key);
      return;
    }

    if (options?.recursive) {
      const prefix = key + "/";
      let cursor: string | undefined;
      do {
        const listed = await this.bucket.list({ prefix, cursor, limit: 100 });
        if (listed.objects.length > 0) {
          await this.bucket.delete(listed.objects.map((o) => o.key));
        }
        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);
      return;
    }

    if (!options?.force) {
      throw new Error(`ENOENT: no such file or directory, unlink '${path}'`);
    }
  }

  async cp(src: string, dest: string, _options?: CpOptions): Promise<void> {
    const srcKey = toKey(src);
    const obj = await this.bucket.get(srcKey);
    if (!obj) throw new Error(`ENOENT: no such file or directory, cp '${src}'`);

    this.assertMode(obj, READ_BIT, src);

    const destKey = toKey(dest);
    const stream = new FixedLengthStream(obj.size);
    obj.body.pipeTo(stream.writable);

    await this.bucket.put(destKey, stream.readable, {
      httpMetadata: obj.httpMetadata,
      customMetadata: {
        uid: String(this.identity.uid),
        gid: String(this.identity.gid),
        mode: obj.customMetadata?.mode ?? "644",
      },
    });
  }

  async mv(src: string, dest: string): Promise<void> {
    await this.cp(src, dest);
    await this.rm(src, { force: true });
  }

  resolvePath(base: string, path: string): string {
    if (path.startsWith("/")) return normalizePath(path);
    const combined = base.endsWith("/") ? base + path : base + "/" + path;
    return normalizePath(combined);
  }

  getAllPaths(): string[] {
    return [];
  }

  async chmod(path: string, mode: number): Promise<void> {
    const key = toKey(path);
    const obj = await this.bucket.get(key);
    if (!obj) throw new Error(`ENOENT: no such file or directory, chmod '${path}'`);

    const fileUid = parseInt(obj.customMetadata?.uid ?? "-1", 10);
    if (this.identity.uid !== 0 && this.identity.uid !== fileUid) {
      throw new Error(`EPERM: operation not permitted, chmod '${path}'`);
    }

    const octal = mode.toString(8).padStart(3, "0");
    const stream = new FixedLengthStream(obj.size);
    obj.body.pipeTo(stream.writable);

    await this.bucket.put(key, stream.readable, {
      httpMetadata: obj.httpMetadata,
      customMetadata: { ...obj.customMetadata, mode: octal },
    });
  }

  /**
   * Change ownership of a file. Streams the body through FixedLengthStream
   * to avoid buffering the entire object in memory.
   * Only root (uid 0) or the current owner can chown.
   */
  async chown(path: string, newUid?: number, newGid?: number): Promise<void> {
    const key = toKey(path);
    const obj = await this.bucket.get(key);
    if (!obj) throw new Error(`ENOENT: no such file or directory, chown '${path}'`);

    const fileUid = parseInt(obj.customMetadata?.uid ?? "-1", 10);
    if (this.identity.uid !== 0 && this.identity.uid !== fileUid) {
      throw new Error(`EPERM: operation not permitted, chown '${path}'`);
    }

    const meta = { ...obj.customMetadata };
    if (newUid !== undefined) meta.uid = String(newUid);
    if (newGid !== undefined) meta.gid = String(newGid);

    const stream = new FixedLengthStream(obj.size);
    obj.body.pipeTo(stream.writable);

    await this.bucket.put(key, stream.readable, {
      httpMetadata: obj.httpMetadata,
      customMetadata: meta,
    });
  }

  async symlink(_target: string, _linkPath: string): Promise<void> {
    throw new Error("ENOSYS: symlinks not supported on R2 filesystem");
  }

  async link(_existingPath: string, _newPath: string): Promise<void> {
    throw new Error("ENOSYS: hard links not supported on R2 filesystem");
  }

  async readlink(_path: string): Promise<string> {
    throw new Error("ENOSYS: symlinks not supported on R2 filesystem");
  }

  async realpath(path: string): Promise<string> {
    return normalizePath(path);
  }

  async utimes(path: string, _atime: Date, _mtime: Date): Promise<void> {
    const key = toKey(path);
    const exists = await this.bucket.head(key);
    if (!exists) throw new Error(`ENOENT: no such file or directory, utimes '${path}'`);
  }

  private assertMode(obj: R2Object | R2ObjectBody, bit: number, path: string): void {
    if (this.identity.uid === 0) return;

    const meta = obj.customMetadata;
    const mode = meta?.mode ?? "644";
    const fileUid = parseInt(meta?.uid ?? "-1", 10);
    const fileGid = parseInt(meta?.gid ?? "-1", 10);

    const digits = mode.padStart(3, "0").slice(-3);
    const owner = parseInt(digits[0], 10);
    const group = parseInt(digits[1], 10);
    const other = parseInt(digits[2], 10);

    if (this.identity.uid === fileUid) {
      if ((owner & bit) !== 0) return;
    } else if (this.identity.gids.includes(fileGid)) {
      if ((group & bit) !== 0) return;
    } else {
      if ((other & bit) !== 0) return;
    }

    throw new Error(`EACCES: permission denied, '${path}'`);
  }
}

function toKey(path: string): string {
  return normalizePath(path).replace(/^\//, "");
}

function normalizePath(path: string): string {
  const segments: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") segments.pop();
    else segments.push(seg);
  }
  return "/" + segments.join("/");
}

function isDirectoryMarker(obj: R2Object | R2ObjectBody): boolean {
  return obj.customMetadata?.dirmarker === "1" || obj.key.endsWith("/.dir");
}

function parseOctalMode(mode: string): number {
  return parseInt(mode, 8);
}

function inferContentType(path: string): string {
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
