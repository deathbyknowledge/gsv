import type {
  FileContent,
  MkdirOptions,
  RmOptions,
} from "just-bash";
import type { ProcessIdentity } from "../syscalls/system";
import type { MountBackend, ExtendedMountStat, FsSearchBackendResult } from "./mount-backend";
import { inferContentType, isTextContentType, normalizePath } from "./utils";

const READ_BIT = 4;
const WRITE_BIT = 2;
const MAX_SEARCH_MATCHES = 500;
const TEXT_DECODER = new TextDecoder();

export class R2MountBackend implements MountBackend {
  constructor(
    private readonly bucket: R2Bucket,
    private readonly identity: ProcessIdentity,
  ) {}

  handles(_path: string): boolean {
    return true;
  }

  async readFile(path: string): Promise<string> {
    const p = normalizePath(path);
    const key = toKey(p);
    const obj = await this.bucket.get(key);
    if (!obj) throw new Error(`ENOENT: no such file or directory, open '${p}'`);
    if (isDirectoryMarker(obj)) throw new Error(`EISDIR: illegal operation on a directory, read '${p}'`);
    this.assertMode(obj, READ_BIT, p);
    return obj.text();
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const p = normalizePath(path);
    const key = toKey(p);
    const obj = await this.bucket.get(key);
    if (!obj) throw new Error(`ENOENT: no such file or directory, open '${p}'`);
    this.assertMode(obj, READ_BIT, p);
    const buf = await obj.arrayBuffer();
    return new Uint8Array(buf);
  }

  async writeFile(path: string, content: FileContent): Promise<void> {
    const p = normalizePath(path);
    const key = toKey(p);
    const existing = await this.bucket.head(key);
    if (existing) this.assertMode(existing, WRITE_BIT, p);

    await this.bucket.put(key, content, {
      httpMetadata: { contentType: inferContentType(p) },
      customMetadata: {
        uid: String(this.identity.uid),
        gid: String(this.identity.gid),
        mode: existing?.customMetadata?.mode ?? "644",
      },
    });
  }

  async appendFile(path: string, content: FileContent): Promise<void> {
    const p = normalizePath(path);
    const key = toKey(p);
    const existing = await this.bucket.get(key);

    if (existing) {
      this.assertMode(existing, WRITE_BIT, p);
      const old = await existing.text();
      const appended = typeof content === "string" ? old + content : old + TEXT_DECODER.decode(content);
      await this.bucket.put(key, appended, {
        httpMetadata: existing.httpMetadata,
        customMetadata: existing.customMetadata,
      });
      return;
    }

    await this.writeFile(path, content);
  }

  async exists(path: string): Promise<boolean> {
    const p = normalizePath(path);
    const key = toKey(p);
    const head = await this.bucket.head(key);
    if (head) return true;

    const dirPrefix = key.endsWith("/") ? key : key + "/";
    const listed = await this.bucket.list({ prefix: dirPrefix, limit: 1 });
    return listed.objects.length > 0 || listed.delimitedPrefixes.length > 0;
  }

  async stat(path: string): Promise<ExtendedMountStat> {
    const p = normalizePath(path);
    const key = toKey(p);
    const head = await this.bucket.head(key);
    if (head) {
      const uid = parseInt(head.customMetadata?.uid ?? "0", 10);
      const gid = parseInt(head.customMetadata?.gid ?? "0", 10);
      if (isDirectoryMarker(head)) {
        return {
          isFile: false,
          isDirectory: true,
          isSymbolicLink: false,
          mode: parseOctalMode(head.customMetadata?.mode ?? "755"),
          size: 0,
          mtime: head.uploaded,
          uid,
          gid,
        };
      }
      return {
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
        mode: parseOctalMode(head.customMetadata?.mode ?? "644"),
        size: head.size,
        mtime: head.uploaded,
        uid,
        gid,
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
        uid: 0,
        gid: 0,
      };
    }

    throw new Error(`ENOENT: no such file or directory, stat '${p}'`);
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    const p = normalizePath(path);
    const key = toKey(p);
    if (!options?.recursive) {
      const parentKey = key.split("/").slice(0, -1).join("/");
      if (parentKey) {
        const parentExists = await this.exists("/" + parentKey);
        if (!parentExists) throw new Error(`ENOENT: no such file or directory, mkdir '${p}'`);
      }
    }

    const dirKey = key.endsWith("/") ? key : key + "/";
    const markerKey = dirKey + ".dir";
    const existing = await this.bucket.head(markerKey);
    if (existing && !options?.recursive) throw new Error(`EEXIST: file already exists, mkdir '${p}'`);

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
    const p = normalizePath(path);
    const key = toKey(p);
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
      if (!dirExists) throw new Error(`ENOENT: no such file or directory, scandir '${p}'`);
    }

    return [...new Set(entries)].sort();
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    const p = normalizePath(path);
    const key = toKey(p);
    const head = await this.bucket.head(key);
    if (head) {
      this.assertMode(head, WRITE_BIT, p);
      await this.bucket.delete(key);
      return;
    }

    const dirPrefix = key.endsWith("/") ? key : key + "/";
    const markerKey = dirPrefix + ".dir";
    const marker = await this.bucket.head(markerKey);
    if (marker) {
      this.assertMode(marker, WRITE_BIT, p);

      const listed = await this.bucket.list({ prefix: dirPrefix, limit: 2 });
      const hasChildren =
        listed.delimitedPrefixes.length > 0 ||
        listed.objects.some((obj) => obj.key !== markerKey);

      if (hasChildren && !options?.recursive) {
        throw new Error(`ENOTEMPTY: directory not empty, rmdir '${p}'`);
      }

      if (options?.recursive) {
        let cursor: string | undefined;
        do {
          const page = await this.bucket.list({ prefix: dirPrefix, cursor, limit: 100 });
          if (page.objects.length > 0) {
            await this.bucket.delete(page.objects.map((o) => o.key));
          }
          cursor = page.truncated ? page.cursor : undefined;
        } while (cursor);
      } else {
        await this.bucket.delete(markerKey);
      }
      return;
    }

    if (options?.recursive) {
      let cursor: string | undefined;
      do {
        const listed = await this.bucket.list({ prefix: dirPrefix, cursor, limit: 100 });
        if (listed.objects.length > 0) {
          await this.bucket.delete(listed.objects.map((o) => o.key));
        }
        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);
      return;
    }

    if (!options?.force) throw new Error(`ENOENT: no such file or directory, unlink '${p}'`);
  }

  async search(path: string, pattern: RegExp, include?: string): Promise<FsSearchBackendResult> {
    const prefix = normalizePath(path);
    const searchPrefix = prefix.endsWith("/") ? prefix : prefix + "/";

    const matches: FsSearchBackendResult["matches"] = [];
    let truncated = false;
    let cursor: string | undefined;

    outer:
    do {
      const listed = await this.bucket.list({
        prefix: searchPrefix === "/" ? undefined : searchPrefix.slice(1),
        cursor,
        limit: 100,
      });

      for (const obj of listed.objects) {
        if (include && !matchGlob(include, obj.key)) continue;

        const contentType = obj.httpMetadata?.contentType || "text/plain";
        if (!isTextContentType(contentType)) continue;

        const full = await this.bucket.get(obj.key);
        if (!full) continue;

        const text = await full.text();
        const lines = text.split("\n");

        for (let i = 0; i < lines.length; i++) {
          pattern.lastIndex = 0;
          if (pattern.test(lines[i])) {
            matches.push({ path: "/" + obj.key, line: i + 1, content: lines[i] });
            if (matches.length >= MAX_SEARCH_MATCHES) {
              truncated = true;
              break outer;
            }
          }
        }
      }

      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);

    return { matches, truncated };
  }

  async chmod(path: string, mode: number): Promise<void> {
    const p = normalizePath(path);
    const key = toKey(p);
    const obj = await this.bucket.get(key);
    if (!obj) throw new Error(`ENOENT: no such file or directory, chmod '${p}'`);

    const fileUid = parseInt(obj.customMetadata?.uid ?? "-1", 10);
    if (this.identity.uid !== 0 && this.identity.uid !== fileUid) {
      throw new Error(`EPERM: operation not permitted, chmod '${p}'`);
    }

    const octal = mode.toString(8).padStart(3, "0");
    const stream = new FixedLengthStream(obj.size);
    obj.body.pipeTo(stream.writable);

    await this.bucket.put(key, stream.readable, {
      httpMetadata: obj.httpMetadata,
      customMetadata: { ...obj.customMetadata, mode: octal },
    });
  }

  async chown(path: string, newUid?: number, newGid?: number): Promise<void> {
    const p = normalizePath(path);
    const key = toKey(p);
    const obj = await this.bucket.get(key);
    if (!obj) throw new Error(`ENOENT: no such file or directory, chown '${p}'`);

    if (this.identity.uid !== 0) {
      throw new Error(`EPERM: operation not permitted, chown '${p}'`);
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

  async utimes(path: string): Promise<void> {
    const p = normalizePath(path);
    const key = toKey(p);
    const exists = await this.bucket.head(key);
    if (!exists) throw new Error(`ENOENT: no such file or directory, utimes '${p}'`);
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
    } else if ((other & bit) !== 0) {
      return;
    }

    throw new Error(`EACCES: permission denied, '${path}'`);
  }
}

function toKey(path: string): string {
  return normalizePath(path).replace(/^\//, "");
}

function isDirectoryMarker(obj: R2Object | R2ObjectBody): boolean {
  return obj.customMetadata?.dirmarker === "1" || obj.key.endsWith("/.dir");
}

function parseOctalMode(mode: string): number {
  return parseInt(mode, 8);
}

function matchGlob(pattern: string, path: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`(^|/)${escaped}$`).test(path);
}
