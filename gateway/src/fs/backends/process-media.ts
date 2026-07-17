import type {
  BufferEncoding,
  FileContent,
  MkdirOptions,
  RmOptions,
} from "just-bash";
import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import type { ProcessRecord } from "../../kernel/processes";
import {
  isProcessMediaPath,
  parseProcessMediaPath,
} from "../../shared/process-media-path";
import type {
  ExtendedMountStat,
  MountBackend,
  OpenFileOptions,
  OpenFileResult,
  WriteFileOptions,
  WriteFileStreamOptions,
  WriteFileStreamResult,
} from "../mount";
import type { KernelRefs } from "../refs";
import { normalizePath } from "../utils";
import { R2MountBackend } from "./r2";

const ROOT_IDENTITY: ProcessIdentity = {
  uid: 0,
  gid: 0,
  gids: [0],
  username: "root",
  home: "/root",
  cwd: "/root",
};

/**
 * Read-only filesystem view over process-owned R2 media.
 *
 * R2 object metadata is not the authorization boundary: visibility follows the
 * process registry, matching /proc (root, self, or another process owned by the
 * same user). This also keeps guessed object keys from bypassing process scope.
 */
export class ProcessMediaMountBackend implements MountBackend {
  private readonly raw: R2MountBackend;

  constructor(
    private readonly bucket: R2Bucket,
    private readonly identity: ProcessIdentity,
    private readonly kernel: KernelRefs | null,
    private readonly selfPid: string | null,
  ) {
    this.raw = new R2MountBackend(bucket, ROOT_IDENTITY);
  }

  handles(path: string): boolean {
    return isProcessMediaPath(normalizePath(path));
  }

  async readFile(
    path: string,
    _options?: { encoding?: BufferEncoding | null } | BufferEncoding,
  ): Promise<string> {
    const normalized = normalizePath(path);
    this.requireVisibleFile(normalized);
    return this.raw.readFile(normalized);
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const normalized = normalizePath(path);
    this.requireVisibleFile(normalized);
    return this.raw.readFileBuffer(normalized);
  }

  async openFile(path: string, options?: OpenFileOptions): Promise<OpenFileResult> {
    const normalized = normalizePath(path);
    this.requireVisibleFile(normalized);
    return this.raw.openFile(normalized, options);
  }

  async writeFile(
    path: string,
    _content: FileContent,
    _options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    throw readOnlyError("open", path);
  }

  async writeFileStream(
    path: string,
    content: ReadableStream<Uint8Array>,
    _options: WriteFileStreamOptions,
  ): Promise<WriteFileStreamResult> {
    const error = readOnlyError("open", path);
    await content.cancel(error).catch(() => {});
    throw error;
  }

  async appendFile(
    path: string,
    _content: FileContent,
    _options?: { encoding?: BufferEncoding } | BufferEncoding,
  ): Promise<void> {
    throw readOnlyError("open", path);
  }

  async exists(path: string): Promise<boolean> {
    const normalized = normalizePath(path);
    const parsed = parseProcessMediaPath(normalized);
    if (!parsed) return false;
    if (parsed.kind === "root") return true;
    if (parsed.kind === "uid") return this.visibleProcesses(parsed.uid).length > 0;

    const process = this.visibleProcess(parsed.uid, parsed.pid);
    if (!process) return false;
    if (parsed.kind === "process") return true;
    return (await this.bucket.head(parsed.key)) !== null;
  }

  async stat(path: string): Promise<ExtendedMountStat> {
    const normalized = normalizePath(path);
    const parsed = parseProcessMediaPath(normalized);
    if (!parsed) throw notFoundError("stat", normalized);

    if (parsed.kind === "root") {
      return directoryStat(0, 0);
    }
    if (parsed.kind === "uid") {
      const records = this.visibleProcesses(parsed.uid);
      if (records.length === 0) throw notFoundError("stat", normalized);
      return directoryStat(parsed.uid, records[0].gid);
    }

    const process = this.visibleProcess(parsed.uid, parsed.pid);
    if (!process) throw notFoundError("stat", normalized);
    if (parsed.kind === "process") {
      return directoryStat(process.uid, process.gid);
    }

    const object = await this.bucket.head(parsed.key);
    if (!object) throw notFoundError("stat", normalized);
    return {
      isFile: true,
      isDirectory: false,
      isSymbolicLink: false,
      mode: 0o400,
      size: object.size,
      mtime: object.uploaded,
      uid: process.uid,
      gid: process.gid,
      contentType: object.httpMetadata?.contentType,
    };
  }

  async lstat(path: string): Promise<ExtendedMountStat> {
    return this.stat(path);
  }

  async mkdir(path: string, _options?: MkdirOptions): Promise<void> {
    throw readOnlyError("mkdir", path);
  }

  async readdir(path: string): Promise<string[]> {
    const normalized = normalizePath(path);
    const parsed = parseProcessMediaPath(normalized);
    if (!parsed) throw notFoundError("scandir", normalized);

    if (parsed.kind === "root") {
      return [...new Set(this.visibleProcesses().map((record) => String(record.uid)))].sort(numericSort);
    }
    if (parsed.kind === "uid") {
      const pids = this.visibleProcesses(parsed.uid).map((record) => record.processId).sort();
      if (pids.length === 0) throw notFoundError("scandir", normalized);
      return pids;
    }

    const process = this.visibleProcess(parsed.uid, parsed.pid);
    if (!process) throw notFoundError("scandir", normalized);
    if (parsed.kind === "file") {
      if (await this.bucket.head(parsed.key)) {
        throw new Error(`ENOTDIR: not a directory, scandir '${normalized}'`);
      }
      throw notFoundError("scandir", normalized);
    }

    const prefix = `var/media/${process.uid}/${process.processId}/`;
    const names = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.bucket.list({ prefix, cursor, limit: 1000 });
      for (const object of page.objects) {
        const name = object.key.slice(prefix.length);
        if (name && !name.includes("/")) names.add(name);
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return [...names].sort();
  }

  async rm(path: string, _options?: RmOptions): Promise<void> {
    throw readOnlyError("unlink", path);
  }

  async symlink(_target: string, linkPath: string): Promise<void> {
    throw readOnlyError("symlink", linkPath);
  }

  async chmod(path: string): Promise<void> {
    throw readOnlyError("chmod", path);
  }

  async chown(path: string): Promise<void> {
    throw readOnlyError("chown", path);
  }

  async utimes(path: string): Promise<void> {
    throw readOnlyError("utimes", path);
  }

  private requireVisibleFile(path: string): void {
    const parsed = parseProcessMediaPath(path);
    if (!parsed) throw notFoundError("open", path);
    if (parsed.kind !== "file") {
      throw new Error(`EISDIR: illegal operation on a directory, read '${path}'`);
    }
    if (!this.visibleProcess(parsed.uid, parsed.pid)) {
      throw notFoundError("open", path);
    }
  }

  private visibleProcesses(uid?: number): ProcessRecord[] {
    if (!this.kernel) return [];
    const ownerUid = this.viewerOwnerUid();
    const records = this.identity.uid === 0
      ? this.kernel.procs.list()
      : this.kernel.procs.list(ownerUid);
    const visible = records.filter((record) => (
      (uid === undefined || record.uid === uid) && this.canViewProcess(record, ownerUid)
    ));

    if (this.selfPid && !visible.some((record) => record.processId === this.selfPid)) {
      const self = this.kernel.procs.get(this.selfPid);
      if (self && (uid === undefined || self.uid === uid) && this.canViewProcess(self, ownerUid)) {
        visible.push(self);
      }
    }
    return visible;
  }

  private visibleProcess(uid: number, pid: string): ProcessRecord | null {
    if (!this.kernel) return null;
    const process = this.kernel.procs.get(pid);
    if (!process || process.uid !== uid) return null;
    return this.canViewProcess(process, this.viewerOwnerUid()) ? process : null;
  }

  private canViewProcess(process: ProcessRecord, ownerUid: number): boolean {
    return this.identity.uid === 0
      || process.processId === this.selfPid
      || process.ownerUid === ownerUid;
  }

  private viewerOwnerUid(): number {
    if (!this.selfPid || !this.kernel) return this.identity.uid;
    return this.kernel.procs.getOwnerUid(this.selfPid) ?? this.identity.uid;
  }
}

function directoryStat(uid: number, gid: number): ExtendedMountStat {
  return {
    isFile: false,
    isDirectory: true,
    isSymbolicLink: false,
    mode: 0o500,
    size: 0,
    mtime: new Date(),
    uid,
    gid,
  };
}

function notFoundError(operation: string, path: string): Error {
  return new Error(`ENOENT: no such file or directory, ${operation} '${normalizePath(path)}'`);
}

function readOnlyError(operation: string, path: string): Error {
  return new Error(`EROFS: read-only file system, ${operation} '${normalizePath(path)}'`);
}

function numericSort(left: string, right: string): number {
  return Number(left) - Number(right);
}
