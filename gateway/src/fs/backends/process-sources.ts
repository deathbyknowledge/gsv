import type {
  FileContent,
  MkdirOptions,
  RmOptions,
} from "just-bash";
import type { ProcessIdentity } from "../../syscalls/system";
import type { ProcessMount } from "../../kernel/processes";
import type { ExtendedMountStat, MountBackend } from "../mount";
import { RipgitClient, type RipgitRepoRef } from "../ripgit/client";
import { normalizePath } from "../utils";

const TEXT_DECODER = new TextDecoder();

export function createProcessSourceBackend(
  identity: ProcessIdentity,
  ripgit: RipgitClient | null,
  mounts: ProcessMount[] | undefined,
): MountBackend | null {
  const normalizedMounts = Array.isArray(mounts)
    ? mounts
      .filter((mount) => mount.kind === "ripgit-source")
      .map((mount) => ({
        ...mount,
        mountPath: normalizePath(mount.mountPath),
        subdir: normalizeRepoPath(mount.subdir),
      }))
      .filter((mount) => mount.mountPath === "/src" || mount.mountPath.startsWith("/src/"))
    : [];

  if (!ripgit || normalizedMounts.length === 0) {
    return null;
  }

  return new ProcessSourceMountBackend(identity, ripgit, normalizedMounts);
}

export function isProcessSourceMountPath(path: string): boolean {
  const normalized = normalizePath(path);
  return normalized === "/src" || normalized.startsWith("/src/");
}

class ProcessSourceMountBackend implements MountBackend {
  private readonly mounts: ProcessMount[];

  constructor(
    private readonly identity: ProcessIdentity,
    private readonly ripgit: RipgitClient,
    mounts: ProcessMount[],
  ) {
    this.mounts = [...mounts].sort((left, right) => right.mountPath.length - left.mountPath.length);
  }

  handles(path: string): boolean {
    return isProcessSourceMountPath(path);
  }

  async readFile(path: string): Promise<string> {
    const { mount, repoPath, normalizedPath } = this.resolveMount(path);
    const result = await this.ripgit.readPath(repoRefForMount(mount), repoPath);
    if (result.kind !== "file") {
      throw new Error(`EISDIR: illegal operation on a directory, read '${normalizedPath}'`);
    }
    return TEXT_DECODER.decode(result.bytes);
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const { mount, repoPath, normalizedPath } = this.resolveMount(path);
    const result = await this.ripgit.readPath(repoRefForMount(mount), repoPath);
    if (result.kind !== "file") {
      throw new Error(`EISDIR: illegal operation on a directory, read '${normalizedPath}'`);
    }
    return result.bytes;
  }

  async writeFile(path: string, _content: FileContent): Promise<void> {
    throw new Error(`EPERM: source mount is read-only '${normalizePath(path)}'`);
  }

  async appendFile(path: string, _content: FileContent): Promise<void> {
    throw new Error(`EPERM: source mount is read-only '${normalizePath(path)}'`);
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.stat(path);
      return true;
    } catch {
      return false;
    }
  }

  async stat(path: string): Promise<ExtendedMountStat> {
    const normalizedPath = normalizePath(path);
    if (normalizedPath === "/src") {
      return makeDirectoryStat(this.identity.uid, this.identity.gid);
    }

    const { mount, repoPath } = this.resolveMount(normalizedPath);
    const result = await this.ripgit.readPath(repoRefForMount(mount), repoPath);
    if (result.kind === "missing") {
      throw new Error(`ENOENT: no such file or directory, stat '${normalizedPath}'`);
    }
    if (result.kind === "tree") {
      return makeDirectoryStat(this.identity.uid, this.identity.gid);
    }
    return {
      isFile: true,
      isDirectory: false,
      isSymbolicLink: false,
      mode: 0o444,
      size: result.size,
      mtime: new Date(),
      uid: this.identity.uid,
      gid: this.identity.gid,
    };
  }

  async mkdir(path: string, _options?: MkdirOptions): Promise<void> {
    throw new Error(`EPERM: source mount is read-only '${normalizePath(path)}'`);
  }

  async readdir(path: string): Promise<string[]> {
    const normalizedPath = normalizePath(path);
    if (normalizedPath === "/src") {
      return [...new Set(this.mounts.map((mount) => mount.mountPath.split("/")[2]).filter(Boolean))].sort();
    }

    const { mount, repoPath } = this.resolveMount(normalizedPath);
    const result = await this.ripgit.readPath(repoRefForMount(mount), repoPath);
    if (result.kind === "missing") {
      throw new Error(`ENOENT: no such file or directory, scandir '${normalizedPath}'`);
    }
    if (result.kind !== "tree") {
      throw new Error(`ENOTDIR: not a directory, scandir '${normalizedPath}'`);
    }
    return result.entries.map((entry) => entry.name).sort();
  }

  async rm(path: string, _options?: RmOptions): Promise<void> {
    throw new Error(`EPERM: source mount is read-only '${normalizePath(path)}'`);
  }

  async chmod(path: string): Promise<void> {
    throw new Error(`EPERM: source mount is read-only '${normalizePath(path)}'`);
  }

  async chown(path: string): Promise<void> {
    throw new Error(`EPERM: source mount is read-only '${normalizePath(path)}'`);
  }

  async utimes(path: string): Promise<void> {
    const normalizedPath = normalizePath(path);
    if (await this.exists(normalizedPath)) {
      return;
    }
    throw new Error(`ENOENT: no such file or directory, utimes '${normalizedPath}'`);
  }

  private resolveMount(path: string): {
    mount: ProcessMount;
    repoPath: string;
    normalizedPath: string;
  } {
    const normalizedPath = normalizePath(path);
    for (const mount of this.mounts) {
      if (normalizedPath === mount.mountPath || normalizedPath.startsWith(`${mount.mountPath}/`)) {
        const relativePath = normalizedPath === mount.mountPath
          ? ""
          : normalizedPath.slice(mount.mountPath.length + 1);
        return {
          mount,
          repoPath: joinRepoPath(mount.subdir, relativePath),
          normalizedPath,
        };
      }
    }
    throw new Error(`ENOENT: no such file or directory, open '${normalizedPath}'`);
  }
}

function repoRefForMount(mount: ProcessMount): RipgitRepoRef {
  const [owner, repo] = mount.repo.split("/", 2);
  if (!owner || !repo) {
    throw new Error(`Invalid mounted repo: ${mount.repo}`);
  }
  return {
    owner,
    repo,
    branch: mount.resolvedCommit ?? mount.ref,
  };
}

function normalizeRepoPath(path: string | null | undefined): string {
  return String(path ?? "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

function joinRepoPath(base: string, relativePath: string): string {
  const normalizedBase = normalizeRepoPath(base);
  const normalizedRelative = normalizeRepoPath(relativePath);
  if (!normalizedBase) {
    return normalizedRelative;
  }
  if (!normalizedRelative) {
    return normalizedBase;
  }
  return `${normalizedBase}/${normalizedRelative}`;
}

function makeDirectoryStat(uid: number, gid: number): ExtendedMountStat {
  return {
    isFile: false,
    isDirectory: true,
    isSymbolicLink: false,
    mode: 0o555,
    size: 0,
    mtime: new Date(),
    uid,
    gid,
  };
}
