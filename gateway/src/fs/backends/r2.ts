import type {
  FileContent,
  MkdirOptions,
  RmOptions,
} from "just-bash";
import { bodyToText, type ProcessIdentity } from "@humansandmachines/gsv/protocol";
import type {
  MountBackend,
  ExtendedMountStat,
  FsSearchBackendResult,
  OpenFileOptions,
  OpenFileRange,
  OpenFileResult,
  WriteFileStreamOptions,
  WriteFileStreamResult,
} from "../mount";
import { concatBytes, inferContentType, isTextContentType, normalizePath } from "../utils";
import { bindStreamToAbort } from "../../shared/streams";

const READ_BIT = 4;
const WRITE_BIT = 2;
const MAX_SEARCH_MATCHES = 500;
const TEXT_ENCODER = new TextEncoder();

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
    if (isSymlink(obj)) throw new Error(`EINVAL: invalid argument, read '${p}' is a symbolic link`);
    this.assertMode(obj, READ_BIT, p);
    return obj.text();
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const p = normalizePath(path);
    const key = toKey(p);
    const obj = await this.bucket.get(key);
    if (!obj) throw new Error(`ENOENT: no such file or directory, open '${p}'`);
    if (isSymlink(obj)) throw new Error(`EINVAL: invalid argument, read '${p}' is a symbolic link`);
    this.assertMode(obj, READ_BIT, p);
    const buf = await obj.arrayBuffer();
    return new Uint8Array(buf);
  }

  async openFile(path: string, options?: OpenFileOptions): Promise<OpenFileResult> {
    const p = normalizePath(path);
    const key = toKey(p);
    const getOptions = toR2GetOptions(options);
    const obj: R2ObjectBody | R2Object | null = getOptions?.onlyIf
      ? await this.bucket.get(key, getOptions as R2GetOptions & { onlyIf: R2Conditional })
      : getOptions
        ? await this.bucket.get(key, getOptions)
        : await this.bucket.get(key);
    if (!obj) throw new Error(`ENOENT: no such file or directory, open '${p}'`);
    if (isDirectoryMarker(obj)) throw new Error(`EISDIR: illegal operation on a directory, read '${p}'`);
    if (isSymlink(obj)) throw new Error(`EINVAL: invalid argument, read '${p}' is a symbolic link`);
    this.assertMode(obj, READ_BIT, p);

    if (!isR2ObjectBody(obj)) {
      return {
        size: obj.size,
        totalSize: obj.size,
        mtime: obj.uploaded,
        status: conditionalMissStatus(options?.conditions),
        contentType: obj.httpMetadata?.contentType,
        etag: obj.httpEtag,
        writeHttpMetadata: (headers) => obj.writeHttpMetadata(headers),
      };
    }

    const totalSize = obj.range ? (await this.bucket.head(key))?.size ?? obj.size : obj.size;
    const range = options?.range && obj.range ? normalizeR2Range(obj.range, totalSize) : undefined;
    return {
      body: obj.body as ReadableStream<Uint8Array>,
      size: range?.length ?? obj.size,
      totalSize,
      mtime: obj.uploaded,
      status: range ? 206 : 200,
      contentType: obj.httpMetadata?.contentType,
      etag: obj.httpEtag,
      range,
      writeHttpMetadata: (headers) => obj.writeHttpMetadata(headers),
    };
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

  async writeFileStream(
    path: string,
    content: ReadableStream<Uint8Array>,
    options: WriteFileStreamOptions,
  ): Promise<WriteFileStreamResult> {
    assertExpectedSize(options?.expectedSize);
    options.signal?.throwIfAborted();
    const p = normalizePath(path);
    const key = toKey(p);
    const existing = await this.bucket.head(key);
    options.signal?.throwIfAborted();
    if (existing) this.assertMode(existing, WRITE_BIT, p);

    const source = options.signal
      ? bindStreamToAbort(content, options.signal)
      : content;
    const fixed = new FixedLengthStream(options.expectedSize);
    const [result] = await Promise.all([
      this.bucket.put(key, fixed.readable, {
        httpMetadata: toR2HttpMetadata(p, options),
        customMetadata: {
          uid: String(this.identity.uid),
          gid: String(this.identity.gid),
          mode: existing?.customMetadata?.mode ?? "644",
        },
      }),
      source.pipeTo(fixed.writable),
    ]);

    return {
      size: result.size,
      streamed: true,
    };
  }

  async appendFile(path: string, content: FileContent): Promise<void> {
    const p = normalizePath(path);
    const key = toKey(p);
    const existing = await this.bucket.get(key);

    if (existing) {
      this.assertMode(existing, WRITE_BIT, p);
      const old = new Uint8Array(await existing.arrayBuffer());
      const appended = concatBytes(old, typeof content === "string" ? TEXT_ENCODER.encode(content) : content);
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
    return this.lstat(path);
  }

  async lstat(path: string): Promise<ExtendedMountStat> {
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
      if (isSymlink(head)) {
        return {
          isFile: false,
          isDirectory: false,
          isSymbolicLink: true,
          mode: parseOctalMode(head.customMetadata?.mode ?? "777"),
          size: head.size,
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

  async symlink(target: string, linkPath: string): Promise<void> {
    const p = normalizePath(linkPath);
    const key = toKey(p);
    const existing = await this.bucket.head(key);
    if (existing) {
      throw new Error(`EEXIST: file already exists, symlink '${p}'`);
    }

    await this.bucket.put(key, target, {
      httpMetadata: { contentType: "text/plain" },
      customMetadata: {
        uid: String(this.identity.uid),
        gid: String(this.identity.gid),
        mode: "777",
        symlink: "1",
      },
    });
  }

  async readlink(path: string): Promise<string> {
    const p = normalizePath(path);
    const obj = await this.bucket.get(toKey(p));
    if (!obj) throw new Error(`ENOENT: no such file or directory, readlink '${p}'`);
    if (!isSymlink(obj)) throw new Error(`EINVAL: invalid argument, readlink '${p}'`);
    return obj.text();
  }

  async search(
    path: string,
    query: string,
    include?: string,
    signal?: AbortSignal,
  ): Promise<FsSearchBackendResult> {
    signal?.throwIfAborted();
    const prefix = normalizePath(path);
    const key = toKey(prefix);
    const searchPrefix = prefix.endsWith("/") ? prefix : prefix + "/";
    const needle = query;

    const matches: FsSearchBackendResult["matches"] = [];
    let truncated = false;

    if (key) {
      const direct = await this.bucket.get(key);
      signal?.throwIfAborted();
      if (direct && !isDirectoryMarker(direct)) {
        truncated = await this.searchObject({
          displayPath: prefix,
          include,
          key,
          matches,
          object: direct,
          query: needle,
          signal,
          throwOnDenied: true,
        });
        return { matches, truncated };
      }
    }

    let cursor: string | undefined;

    outer:
    do {
      const listed = await this.bucket.list({
        prefix: searchPrefix === "/" ? undefined : searchPrefix.slice(1),
        cursor,
        limit: 100,
      });
      signal?.throwIfAborted();

      for (const obj of listed.objects) {
        signal?.throwIfAborted();
        if (include && !matchGlob(include, obj.key)) continue;

        const full = await this.bucket.get(obj.key);
        signal?.throwIfAborted();
        if (!full) continue;
        if (isDirectoryMarker(full) || isSymlink(full)) continue;

        truncated = await this.searchObject({
          displayPath: "/" + obj.key,
          include: undefined,
          key: obj.key,
          matches,
          object: full,
          query: needle,
          signal,
          throwOnDenied: false,
        });
        if (truncated) {
          break outer;
        }
      }

      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);

    return { matches, truncated };
  }

  private async searchObject({
    displayPath,
    include,
    key,
    matches,
    object,
    query,
    signal,
    throwOnDenied,
  }: {
    displayPath: string;
    include: string | undefined;
    key: string;
    matches: FsSearchBackendResult["matches"];
    object: R2ObjectBody;
    query: string;
    signal?: AbortSignal;
    throwOnDenied: boolean;
  }): Promise<boolean> {
    if (include && !matchGlob(include, key)) {
      return false;
    }
    if (isSymlink(object)) {
      if (throwOnDenied) {
        throw new Error(`EINVAL: invalid argument, search '${displayPath}' is a symbolic link`);
      }
      return false;
    }

    try {
      this.assertMode(object, READ_BIT, displayPath);
    } catch (err) {
      if (throwOnDenied) {
        throw err;
      }
      return false;
    }

    const contentType = object.httpMetadata?.contentType || "text/plain";
    if (!isTextContentType(contentType)) {
      return false;
    }

    const text = await bodyToText(
      { stream: object.body as ReadableStream<Uint8Array>, length: object.size },
      Infinity,
      signal,
    );
    const lines = text.split("\n");

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(query)) {
        matches.push({ path: displayPath, line: i + 1, content: lines[i] });
        if (matches.length >= MAX_SEARCH_MATCHES) {
          return true;
        }
      }
    }

    return false;
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

function isSymlink(obj: R2Object | R2ObjectBody): boolean {
  return obj.customMetadata?.symlink === "1";
}

function isR2ObjectBody(obj: R2Object | R2ObjectBody): obj is R2ObjectBody {
  return "body" in obj;
}

function toR2GetOptions(options: OpenFileOptions | undefined): R2GetOptions | undefined {
  if (!options?.conditions && !options?.range) {
    return undefined;
  }

  const getOptions: R2GetOptions = {};
  if (options.conditions) {
    getOptions.onlyIf = {
      etagMatches: options.conditions.etagMatches,
      etagDoesNotMatch: options.conditions.etagDoesNotMatch,
      uploadedBefore: options.conditions.mtimeBefore,
      uploadedAfter: options.conditions.mtimeAfter,
      secondsGranularity: Boolean(options.conditions.mtimeBefore || options.conditions.mtimeAfter),
    };
  }
  if (options.range) {
    getOptions.range = options.range;
  }
  return getOptions;
}

function conditionalMissStatus(conditions: OpenFileOptions["conditions"] | undefined): 304 | 412 {
  if (conditions?.etagDoesNotMatch || conditions?.mtimeAfter) {
    return 304;
  }
  return 412;
}

function toR2HttpMetadata(path: string, options: WriteFileStreamOptions): R2HTTPMetadata {
  return {
    contentType: options.contentType ?? inferContentType(path),
    cacheControl: options.cacheControl,
    contentDisposition: options.contentDisposition,
  };
}

function assertExpectedSize(size: unknown): asserts size is number {
  if (!Number.isSafeInteger(size) || (size as number) < 0) {
    throw new Error("EINVAL: writeFileStream expectedSize must be a non-negative safe integer");
  }
}

function normalizeR2Range(range: R2Range, totalSize: number): OpenFileRange | undefined {
  if ("offset" in range && typeof range.offset === "number") {
    const length = typeof range.length === "number"
      ? range.length
      : Math.max(0, totalSize - range.offset);
    return {
      offset: range.offset,
      length,
      total: totalSize,
    };
  }

  if ("suffix" in range && typeof range.suffix === "number") {
    const length = Math.min(range.suffix, totalSize);
    return {
      offset: Math.max(0, totalSize - length),
      length,
      total: totalSize,
    };
  }

  return undefined;
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
