/**
 * GsvFs — unified IFileSystem implementation for gateway.
 *
 * Explicit mount routing:
 *   /proc/*, /dev/*, /sys/*, /var/{spool,log}/*, /etc/{passwd,shadow,group,cron.d} → KernelMountBackend
 *   /src/repos/*                                       → Process source/ripgit repo backend
 *   /usr/local/bin/*                                      → Package backend
 *   everything else                                           → R2 backend
 *
 * Two paths remain hybrid in GsvFs itself:
 *   /      → root directory union across mounted namespaces + R2
 *   /etc   → auth virtual files overlaid on top of regular storage
 *   /var   → runtime views overlaid on top of regular storage
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
import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import type { KernelRefs } from "./refs";
import type {
  MountBackend,
  ExtendedMountStat,
  FsSearchBackendResult,
  OpenFileRange,
  OpenFileRangeRequest,
  OpenFileOptions,
  OpenFileResult,
  WriteFileOptions,
  WriteFileStreamOptions,
  WriteFileStreamResult,
} from "./mount";
import { R2MountBackend } from "./backends/r2";
import { KernelMountBackend } from "./backends/kernel";
import { isAccountHomeReservedPath } from "./backends/account-home";
import { isPackageMountPath } from "./backends/packages";
import { isProcessSourcePath } from "./backends/process-sources";
import { normalizePath } from "./utils";
import { bindStreamToAbort } from "../shared/streams";

const MAX_SYMLINK_DEPTH = 16;

export type ExtendedStat = ExtendedMountStat;

export class GsvFs implements IFileSystem {
  private readonly identity: ProcessIdentity;
  private readonly kernel: KernelRefs | null;
  private readonly r2Backend: MountBackend;
  private readonly kernelBackend: MountBackend;
  private readonly sourceBackend: MountBackend | null;
  private readonly accountHomeBackend: MountBackend | null;
  private readonly packageBackend: MountBackend | null;

  constructor(
    bucket: R2Bucket,
    identity: ProcessIdentity,
    kernel?: KernelRefs,
    selfPid?: string,
    sourceBackend?: MountBackend | null,
    accountHomeBackend?: MountBackend | null,
    packageBackend?: MountBackend | null,
  ) {
    this.identity = identity;
    this.kernel = kernel ?? null;
    this.r2Backend = new R2MountBackend(bucket, identity);
    this.kernelBackend = new KernelMountBackend(identity, this.kernel, selfPid ?? null);
    this.sourceBackend = sourceBackend ?? null;
    this.accountHomeBackend = accountHomeBackend ?? null;
    this.packageBackend = packageBackend ?? null;
  }

  async readFile(path: string, options?: { encoding?: BufferEncoding | null } | BufferEncoding): Promise<string> {
    const p = await this.resolveFinalPath(path);
    return this.backendForPath(p).readFile(p, options);
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const p = await this.resolveFinalPath(path);
    return this.backendForPath(p).readFileBuffer(p);
  }

  async openFile(path: string, options?: OpenFileOptions): Promise<OpenFileResult> {
    const p = await this.resolveFinalPath(path);
    const backend = this.backendForPath(p);
    if (backend.openFile) {
      const opened = await backend.openFile(p, options);
      if (opened) {
        return opened;
      }
    }
    const stat = await backend.stat(p);
    if (!stat.isFile) {
      throw new Error(`EISDIR: illegal operation on a directory, open '${p}'`);
    }
    const etag = weakStatEtag(stat);
    const conditionalStatus = evaluateOpenFileConditions(stat, etag, options?.conditions);
    if (conditionalStatus) {
      return {
        size: stat.size,
        totalSize: stat.size,
        mtime: stat.mtime,
        status: conditionalStatus,
        etag,
      };
    }
    const range = options?.range
      ? resolveOpenFileRange(options.range, stat.size)
      : undefined;
    const bytes = await backend.readFileBuffer(p);
    const body = range
      ? bytes.subarray(range.offset, range.offset + range.length)
      : bytes;
    const size = body.byteLength;
    return {
      body: bytesToStream(body),
      size,
      totalSize: stat.size,
      mtime: stat.mtime,
      status: range ? 206 : 200,
      contentType: stat.contentType,
      etag,
      ...(range ? { range } : {}),
    };
  }

  async writeFile(path: string, content: FileContent, options?: WriteFileOptions | BufferEncoding): Promise<void> {
    const p = await this.resolveFinalPath(path, { allowMissingFinal: true });
    await this.backendForPath(p).writeFile(p, content, options);
  }

  async writeFileStream(
    path: string,
    content: ReadableStream<Uint8Array>,
    options: WriteFileStreamOptions,
  ): Promise<WriteFileStreamResult> {
    assertExpectedSize(options?.expectedSize);
    options.signal?.throwIfAborted();
    const p = await this.resolveFinalPath(path, { allowMissingFinal: true });
    options.signal?.throwIfAborted();
    const backend = this.backendForPath(p);
    if (backend.writeFileStream) {
      const result = await backend.writeFileStream(p, content, options);
      if (result) {
        return result;
      }
    }

    const bytes = await streamToBytes(content, options.expectedSize, options.signal);
    await backend.writeFile(p, bytes, {
      contentType: options.contentType,
    });
    return {
      size: bytes.byteLength,
      streamed: false,
    };
  }

  async appendFile(path: string, content: FileContent, options?: { encoding?: BufferEncoding } | BufferEncoding): Promise<void> {
    const p = await this.resolveFinalPath(path, { allowMissingFinal: true });
    await this.backendForPath(p).appendFile(p, content, options);
  }

  async exists(path: string): Promise<boolean> {
    const p = normalizePath(path);
    if (p === "/") return true;
    if (p === "/etc" && this.kernel) return true;
    return this.backendForPath(p).exists(p);
  }

  async stat(path: string): Promise<FsStat> {
    const ext = await this.statExtended(path);
    return {
      isFile: ext.isFile,
      isDirectory: ext.isDirectory,
      isSymbolicLink: ext.isSymbolicLink,
      mode: ext.mode,
      size: ext.size,
      mtime: ext.mtime,
    };
  }

  async statExtended(path: string): Promise<ExtendedStat> {
    const normalized = normalizePath(path);

    if (normalized === "/") {
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

    if (normalized === "/etc" && this.kernel) {
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

    const p = await this.resolveFinalPath(normalized);
    return this.backendForPath(p).stat(p);
  }

  async lstat(path: string): Promise<FsStat> {
    const p = normalizePath(path);
    const ext = p === "/" || (p === "/etc" && this.kernel)
      ? await this.statExtended(p)
      : await this.backendLstat(p);
    return {
      isFile: ext.isFile,
      isDirectory: ext.isDirectory,
      isSymbolicLink: ext.isSymbolicLink,
      mode: ext.mode,
      size: ext.size,
      mtime: ext.mtime,
    };
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    const p = normalizePath(path);
    await this.backendForPath(p).mkdir(p, options);
  }

  async readdir(path: string): Promise<string[]> {
    const normalized = normalizePath(path);

    if (normalized === "/") {
      return this.readdirRoot();
    }

    if (normalized === "/etc" && this.kernel) {
      return this.readdirEtc();
    }

    if (normalized === "/var" && this.kernel) {
      return this.readdirVar();
    }

    const p = await this.resolveFinalPath(normalized);
    return this.backendForPath(p).readdir(p);
  }

  async readdirWithFileTypes(path: string): Promise<{ name: string; isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean }[]> {
    const normalized = normalizePath(path);
    const names = await this.readdir(normalized);
    const statParent = normalized === "/" || (normalized === "/etc" && this.kernel)
      ? normalized
      : await this.resolveFinalPath(normalized);
    const results: { name: string; isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean }[] = [];
    for (const name of names) {
      const childPath = statParent.endsWith("/") ? statParent + name : statParent + "/" + name;
      try {
        const s = await this.lstat(childPath);
        results.push({ name, isFile: s.isFile, isDirectory: s.isDirectory, isSymbolicLink: s.isSymbolicLink });
      } catch {
        results.push({ name, isFile: true, isDirectory: false, isSymbolicLink: false });
      }
    }
    return results;
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    const p = normalizePath(path);
    await this.backendForPath(p).rm(p, options);
  }

  async cp(src: string, dest: string, _options?: CpOptions): Promise<void> {
    const sp = await this.resolveFinalPath(src);
    const dp = await this.resolveFinalPath(dest, { allowMissingFinal: true });
    const srcStat = await this.stat(sp);
    if (srcStat.isDirectory) {
      throw new Error(`EISDIR: illegal operation on a directory, cp '${sp}'`);
    }
    const buf = await this.readFileBuffer(sp);
    await this.writeFile(dp, buf);
  }

  async mv(src: string, dest: string): Promise<void> {
    await this.cp(src, dest);
    await this.rm(src, { force: true });
  }

  async chmod(path: string, mode: number): Promise<void> {
    const p = await this.resolveFinalPath(path);
    const backend = this.backendForPath(p);
    if (!backend.chmod) {
      throw new Error(`ENOSYS: chmod not supported for '${p}'`);
    }
    await backend.chmod(p, mode);
  }

  async chown(path: string, newUid?: number, newGid?: number): Promise<void> {
    const p = await this.resolveFinalPath(path);
    const backend = this.backendForPath(p);
    if (!backend.chown) {
      throw new Error(`ENOSYS: chown not supported for '${p}'`);
    }
    await backend.chown(p, newUid, newGid);
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    const p = normalizePath(linkPath);
    const backend = this.backendForPath(p);
    if (!backend.symlink) {
      throw new Error(`ENOSYS: symlinks not supported for '${p}'`);
    }
    await backend.symlink(target, p);
  }

  async link(_existingPath: string, _newPath: string): Promise<void> {
    throw new Error("ENOSYS: hard links not supported");
  }

  async readlink(path: string): Promise<string> {
    const p = normalizePath(path);
    const backend = this.backendForPath(p);
    if (!backend.readlink) {
      throw new Error(`EINVAL: invalid argument, readlink '${p}'`);
    }
    return backend.readlink(p);
  }

  async realpath(path: string): Promise<string> {
    return this.resolveFinalPath(path);
  }

  async utimes(path: string, atime: Date, mtime: Date): Promise<void> {
    const p = await this.resolveFinalPath(path);
    const backend = this.backendForPath(p);
    if (!backend.utimes) {
      const exists = await backend.exists(p);
      if (!exists) throw new Error(`ENOENT: no such file or directory, utimes '${p}'`);
      return;
    }
    await backend.utimes(p, atime, mtime);
  }

  resolvePath(base: string, path: string): string {
    if (path.startsWith("/")) return normalizePath(path);
    const combined = base.endsWith("/") ? base + path : base + "/" + path;
    return normalizePath(combined);
  }

  getAllPaths(): string[] {
    return [];
  }

  async search(
    path: string,
    query: string,
    include?: string,
    signal?: AbortSignal,
  ): Promise<FsSearchBackendResult> {
    signal?.throwIfAborted();
    const p = await this.resolveFinalPath(path);
    signal?.throwIfAborted();
    const backend = this.backendForPath(p);
    if (!backend.search) {
      throw new Error(`ENOSYS: search is not supported for '${p}'`);
    }
    return backend.search(p, query, include, signal);
  }

  private async resolveFinalPath(
    path: string,
    options?: { allowMissingFinal?: boolean },
    depth = 0,
  ): Promise<string> {
    const normalized = normalizePath(path);
    if (this.accountHomeBackend && isAccountHomeReservedPath(normalized) && !this.accountHomeBackend.handles(normalized)) {
      throw new Error(`EACCES: permission denied, '${normalized}'`);
    }

    if (depth > MAX_SYMLINK_DEPTH) {
      throw new Error(`ELOOP: too many symbolic links, '${path}'`);
    }

    const parts = normalized.split("/").filter(Boolean);
    if (parts.length === 0) {
      return "/";
    }

    let current = "/";
    for (let index = 0; index < parts.length; index += 1) {
      current = normalizePath(`${current}/${parts[index]}`);
      const backend = this.backendForPath(current);
      let stat: ExtendedMountStat;
      try {
        stat = backend.lstat ? await backend.lstat(current) : await backend.stat(current);
      } catch (error) {
        if (options?.allowMissingFinal) {
          return normalizePath(`/${parts.join("/")}`);
        }
        throw error;
      }

      if (stat.isSymbolicLink) {
        if (!backend.readlink) {
          throw new Error(`EINVAL: invalid symbolic link '${current}'`);
        }
        const target = await backend.readlink(current);
        const resolvedTarget = this.resolveSymlinkTarget(current, target);
        const rest = parts.slice(index + 1).join("/");
        return this.resolveFinalPath(
          rest ? `${resolvedTarget}/${rest}` : resolvedTarget,
          options,
          depth + 1,
        );
      }
    }
    return current;
  }

  private resolveSymlinkTarget(linkPath: string, target: string): string {
    if (target.startsWith("/")) {
      return normalizePath(target);
    }
    const parent = linkPath.split("/").slice(0, -1).join("/") || "/";
    return normalizePath(`${parent}/${target}`);
  }

  private async backendLstat(path: string): Promise<ExtendedMountStat> {
    const backend = this.backendForPath(path);
    return backend.lstat ? backend.lstat(path) : this.statExtended(path);
  }

  private backendForPath(path: string): MountBackend {
    if (isProcessSourcePath(path)) {
      if (!this.sourceBackend) {
        throw new Error(`ENOSYS: source backend is unavailable for '${path}'`);
      }
      return this.sourceBackend;
    }

    if (this.accountHomeBackend?.handles(path)) {
      return this.accountHomeBackend;
    }

    if (this.accountHomeBackend && isAccountHomeReservedPath(path)) {
      throw new Error(`EACCES: permission denied, '${normalizePath(path)}'`);
    }

    if (isPackageMountPath(path)) {
      if (!this.packageBackend) {
        throw new Error(`ENOSYS: package backend is unavailable for '${path}'`);
      }
      return this.packageBackend;
    }

    if (this.kernelBackend.handles(path)) {
      return this.kernelBackend;
    }

    return this.r2Backend;
  }

  private async readdirRoot(): Promise<string[]> {
    const entries = new Set<string>();

    for (const name of await this.r2Backend.readdir("/").catch(() => [] as string[])) {
      entries.add(name);
    }

    if (this.kernel) {
      entries.add("proc");
      entries.add("dev");
      entries.add("sys");
      entries.add("etc");
      entries.add("var");
    }

    if (this.accountHomeBackend) {
      const homeRoot = this.identity.home.replace(/^\/+/, "").split("/", 1)[0];
      if (homeRoot) {
        entries.add(homeRoot);
      }
    }

    if (this.sourceBackend) {
      entries.add("src");
    }

    if (this.packageBackend) {
      entries.add("usr");
    }

    return [...entries].sort();
  }

  private async readdirEtc(): Promise<string[]> {
    const entries = new Set<string>();
    for (const name of await this.r2Backend.readdir("/etc").catch(() => [] as string[])) {
      entries.add(name);
    }
    entries.add("cron.d");
    entries.add("passwd");
    entries.add("shadow");
    entries.add("group");
    return [...entries].sort();
  }

  private async readdirVar(): Promise<string[]> {
    const entries = new Set<string>();
    for (const name of await this.r2Backend.readdir("/var").catch(() => [] as string[])) {
      entries.add(name);
    }
    for (const name of await this.kernelBackend.readdir("/var").catch(() => [] as string[])) {
      entries.add(name);
    }
    return [...entries].sort();
  }
}

function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  const source: UnderlyingByteSource = {
    type: "bytes",
    start(controller) {
      if (bytes.byteLength > 0) {
        controller.enqueue(bytes);
      }
      controller.close();
    },
  };
  return new ReadableStream(source);
}

function resolveOpenFileRange(range: OpenFileRangeRequest, total: number): OpenFileRange {
  if ("suffix" in range) {
    const length = Math.min(Math.max(0, range.suffix), total);
    return {
      offset: Math.max(0, total - length),
      length,
      total,
    };
  }

  const offset = Math.min(Math.max(0, range.offset), total);
  const requestedLength = range.length ?? Math.max(0, total - offset);
  const length = Math.min(Math.max(0, requestedLength), Math.max(0, total - offset));
  return {
    offset,
    length,
    total,
  };
}

function assertExpectedSize(size: unknown): asserts size is number {
  if (!Number.isSafeInteger(size) || (size as number) < 0) {
    throw new Error("EINVAL: writeFileStream expectedSize must be a non-negative safe integer");
  }
}

async function streamToBytes(
  stream: ReadableStream<Uint8Array>,
  expectedSize: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const reader = (signal ? bindStreamToAbort(stream, signal) : stream).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > expectedSize) {
        const error = new Error(`EFBIG: stream exceeds expectedSize ${expectedSize}`);
        await reader.cancel(error).catch(() => {});
        throw error;
      }
      chunks.push(value);
    }
    signal?.throwIfAborted();
  } finally {
    reader.releaseLock();
  }

  if (size !== expectedSize) {
    throw new Error(`EINVAL: stream size ${size} did not match expectedSize ${expectedSize}`);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function evaluateOpenFileConditions(
  stat: { size: number; mtime: Date },
  etag: string,
  conditions: OpenFileOptions["conditions"] | undefined,
): 304 | 412 | null {
  if (!conditions) {
    return null;
  }

  if (conditions.etagMatches && conditions.etagMatches !== "*" && conditions.etagMatches !== etag) {
    return 412;
  }
  if (conditions.etagDoesNotMatch && (conditions.etagDoesNotMatch === "*" || conditions.etagDoesNotMatch === etag)) {
    return 304;
  }
  if (conditions.mtimeBefore && stat.mtime.getTime() > conditions.mtimeBefore.getTime()) {
    return 412;
  }
  if (conditions.mtimeAfter && stat.mtime.getTime() <= conditions.mtimeAfter.getTime()) {
    return 304;
  }

  return null;
}

function weakStatEtag(stat: { size: number; mtime: Date }): string {
  return `W/"${stat.size.toString(16)}-${stat.mtime.getTime().toString(16)}"`;
}
