/**
 * GsvFs — unified IFileSystem implementation for gateway.
 *
 * Explicit mount routing:
 *   /proc/*, /dev/*, /sys/*, /etc/{passwd,shadow,group} → KernelMountBackend
 *   /usr/local/bin/*                                      → Package backend
 *   /workspaces/*                                             → Workspace backend
 *   everything else                                           → R2 backend
 *
 * Two paths remain hybrid in GsvFs itself:
 *   /      → root directory union across mounted namespaces + R2
 *   /etc   → auth virtual files overlaid on top of regular storage
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
import type { ProcessIdentity } from "../syscalls/system";
import type { KernelRefs } from "./refs";
import type { MountBackend, ExtendedMountStat, FsSearchBackendResult } from "./mount";
import { R2MountBackend } from "./backends/r2";
import { KernelMountBackend } from "./backends/kernel";
import { isPackageMountPath } from "./backends/packages";
import { isProcessSourceMountPath } from "./backends/process-sources";
import { isWorkspaceMountPath } from "./backends/workspace";
import { normalizePath } from "./utils";

export type ExtendedStat = ExtendedMountStat;

export class GsvFs implements IFileSystem {
  private readonly identity: ProcessIdentity;
  private readonly kernel: KernelRefs | null;
  private readonly r2Backend: MountBackend;
  private readonly kernelBackend: MountBackend;
  private readonly sourceMountBackend: MountBackend | null;
  private readonly homeKnowledgeBackend: MountBackend | null;
  private readonly workspaceBackend: MountBackend | null;
  private readonly packageBackend: MountBackend | null;

  constructor(
    bucket: R2Bucket,
    identity: ProcessIdentity,
    kernel?: KernelRefs,
    selfPid?: string,
    sourceMountBackend?: MountBackend | null,
    homeKnowledgeBackend?: MountBackend | null,
    workspaceBackend?: MountBackend | null,
    packageBackend?: MountBackend | null,
  ) {
    this.identity = identity;
    this.kernel = kernel ?? null;
    this.r2Backend = new R2MountBackend(bucket, identity);
    this.kernelBackend = new KernelMountBackend(identity, this.kernel, selfPid ?? null);
    this.sourceMountBackend = sourceMountBackend ?? null;
    this.homeKnowledgeBackend = homeKnowledgeBackend ?? null;
    this.workspaceBackend = workspaceBackend ?? null;
    this.packageBackend = packageBackend ?? null;
  }

  async readFile(path: string, options?: { encoding?: BufferEncoding | null } | BufferEncoding): Promise<string> {
    const p = normalizePath(path);
    return this.backendForPath(p).readFile(p, options);
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const p = normalizePath(path);
    return this.backendForPath(p).readFileBuffer(p);
  }

  async writeFile(path: string, content: FileContent, options?: { encoding?: BufferEncoding } | BufferEncoding): Promise<void> {
    const p = normalizePath(path);
    await this.backendForPath(p).writeFile(p, content, options);
  }

  async appendFile(path: string, content: FileContent, options?: { encoding?: BufferEncoding } | BufferEncoding): Promise<void> {
    const p = normalizePath(path);
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
    const p = normalizePath(path);

    if (p === "/") {
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

    if (p === "/etc" && this.kernel) {
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

    return this.backendForPath(p).stat(p);
  }

  async lstat(path: string): Promise<FsStat> {
    return this.stat(path);
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    const p = normalizePath(path);
    await this.backendForPath(p).mkdir(p, options);
  }

  async readdir(path: string): Promise<string[]> {
    const p = normalizePath(path);

    if (p === "/") {
      return this.readdirRoot();
    }

    if (p === "/etc" && this.kernel) {
      return this.readdirEtc();
    }

    return this.backendForPath(p).readdir(p);
  }

  async readdirWithFileTypes(path: string): Promise<{ name: string; isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean }[]> {
    const names = await this.readdir(path);
    const results: { name: string; isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean }[] = [];
    for (const name of names) {
      const childPath = path.endsWith("/") ? path + name : path + "/" + name;
      try {
        const s = await this.stat(childPath);
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
    const sp = normalizePath(src);
    const dp = normalizePath(dest);
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
    const p = normalizePath(path);
    const backend = this.backendForPath(p);
    if (!backend.chmod) {
      throw new Error(`ENOSYS: chmod not supported for '${p}'`);
    }
    await backend.chmod(p, mode);
  }

  async chown(path: string, newUid?: number, newGid?: number): Promise<void> {
    const p = normalizePath(path);
    const backend = this.backendForPath(p);
    if (!backend.chown) {
      throw new Error(`ENOSYS: chown not supported for '${p}'`);
    }
    await backend.chown(p, newUid, newGid);
  }

  async symlink(_target: string, _linkPath: string): Promise<void> {
    throw new Error("ENOSYS: symlinks not supported");
  }

  async link(_existingPath: string, _newPath: string): Promise<void> {
    throw new Error("ENOSYS: hard links not supported");
  }

  async readlink(_path: string): Promise<string> {
    throw new Error("ENOSYS: symlinks not supported");
  }

  async realpath(path: string): Promise<string> {
    return normalizePath(path);
  }

  async utimes(path: string, atime: Date, mtime: Date): Promise<void> {
    const p = normalizePath(path);
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

  async search(path: string, query: string, include?: string): Promise<FsSearchBackendResult> {
    const p = normalizePath(path);
    const backend = this.backendForPath(p);
    if (!backend.search) {
      throw new Error(`ENOSYS: search is not supported for '${p}'`);
    }
    return backend.search(p, query, include);
  }

  private backendForPath(path: string): MountBackend {
    if (isProcessSourceMountPath(path)) {
      if (!this.sourceMountBackend) {
        throw new Error(`ENOSYS: source mount backend is unavailable for '${path}'`);
      }
      return this.sourceMountBackend;
    }

    if (isWorkspaceMountPath(path)) {
      if (!this.workspaceBackend) {
        throw new Error(`ENOSYS: workspace backend is unavailable for '${path}'`);
      }
      return this.workspaceBackend;
    }

    if (this.homeKnowledgeBackend?.handles(path)) {
      return this.homeKnowledgeBackend;
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
    }

    if (this.workspaceBackend) {
      entries.add("workspaces");
    }

    if (this.homeKnowledgeBackend) {
      const homeRoot = this.identity.home.replace(/^\/+/, "").split("/", 1)[0];
      if (homeRoot) {
        entries.add(homeRoot);
      }
    }

    if (this.sourceMountBackend) {
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
    entries.add("passwd");
    entries.add("shadow");
    entries.add("group");
    return [...entries].sort();
  }
}
