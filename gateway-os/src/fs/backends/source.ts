import type {
  FileContent,
  MkdirOptions,
  RmOptions,
} from "just-bash";
import type { ConfigStore } from "../../kernel/config";
import type { FsSearchMatch } from "../../syscalls/search";
import type { ExtendedMountStat, FsSearchBackendResult, MountBackend } from "../mount";
import {
  RipgitClient,
  type RipgitRepoRef,
} from "../ripgit/client";
import { normalizePath } from "../utils";

const SOURCE_ROOT = "/src";
const SOURCE_ALIAS = "gsv";
const TEXT_DECODER = new TextDecoder();

type SourceConfig = Pick<ConfigStore, "get">;

type SourceRepoPath = {
  repo: RipgitRepoRef;
  relativePath: string;
  absolutePath: string;
};

export function createSourceBackend(
  env: Env,
  config: SourceConfig,
): MountBackend | null {
  const repo = readSourceRepo(config);
  if (!repo || !env.RIPGIT) {
    return null;
  }

  return new SourceMountBackend(
    new RipgitClient(env.RIPGIT, env.RIPGIT_INTERNAL_KEY ?? null),
    repo,
  );
}

export function isSourceMountPath(path: string): boolean {
  return path === SOURCE_ROOT || path.startsWith(`${SOURCE_ROOT}/`);
}

class SourceMountBackend implements MountBackend {
  constructor(
    private readonly client: RipgitClient,
    private readonly repo: RipgitRepoRef,
  ) {}

  handles(path: string): boolean {
    return isSourceMountPath(path);
  }

  async readFile(path: string): Promise<string> {
    const bytes = await this.readFileBuffer(path);
    return TEXT_DECODER.decode(bytes);
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const repoPath = this.resolveRepo(path);
    if (repoPath.relativePath === "") {
      throw new Error(`EISDIR: illegal operation on a directory, read '${repoPath.absolutePath}'`);
    }

    const result = await this.client.readPath(repoPath.repo, repoPath.relativePath);
    if (result.kind === "missing") {
      throw new Error(`ENOENT: no such file or directory, open '${repoPath.absolutePath}'`);
    }
    if (result.kind === "tree") {
      throw new Error(`EISDIR: illegal operation on a directory, read '${repoPath.absolutePath}'`);
    }

    return result.bytes;
  }

  async writeFile(path: string, _content: FileContent): Promise<void> {
    throw new Error(`EPERM: cannot write to read-only source mirror '${normalizePath(path)}'`);
  }

  async appendFile(path: string, _content: FileContent): Promise<void> {
    throw new Error(`EPERM: cannot append to read-only source mirror '${normalizePath(path)}'`);
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
    const normalized = normalizePath(path);
    if (normalized === SOURCE_ROOT) {
      return makeDirStat(normalized);
    }

    const repoPath = this.resolveRepo(normalized);
    if (repoPath.relativePath === "") {
      return makeDirStat(repoPath.absolutePath);
    }

    const result = await this.client.readPath(repoPath.repo, repoPath.relativePath);
    if (result.kind === "missing") {
      throw new Error(`ENOENT: no such file or directory, stat '${repoPath.absolutePath}'`);
    }
    if (result.kind === "tree") {
      return makeDirStat(repoPath.absolutePath);
    }

    return {
      isFile: true,
      isDirectory: false,
      isSymbolicLink: false,
      mode: 0o444,
      size: result.size,
      mtime: new Date(),
      uid: 0,
      gid: 0,
    };
  }

  async mkdir(path: string, _options?: MkdirOptions): Promise<void> {
    throw new Error(`EPERM: cannot mkdir in read-only source mirror '${normalizePath(path)}'`);
  }

  async readdir(path: string): Promise<string[]> {
    const normalized = normalizePath(path);
    if (normalized === SOURCE_ROOT) {
      return [SOURCE_ALIAS];
    }

    const repoPath = this.resolveRepo(normalized);
    const result = await this.client.readPath(repoPath.repo, repoPath.relativePath);
    if (result.kind === "missing") {
      throw new Error(`ENOENT: no such file or directory, scandir '${repoPath.absolutePath}'`);
    }
    if (result.kind !== "tree") {
      throw new Error(`ENOTDIR: not a directory, scandir '${repoPath.absolutePath}'`);
    }

    return result.entries.map((entry) => entry.name).sort();
  }

  async rm(path: string, _options?: RmOptions): Promise<void> {
    throw new Error(`EPERM: cannot remove from read-only source mirror '${normalizePath(path)}'`);
  }

  async search(path: string, query: string): Promise<FsSearchBackendResult> {
    const repoPath = this.resolveRepo(path);
    const result = await this.client.search(
      repoPath.repo,
      query,
      repoPath.relativePath || undefined,
    );

    const matches: FsSearchMatch[] = result.matches.map((match) => ({
      path: `${SOURCE_ROOT}/${SOURCE_ALIAS}/${match.path}`.replace(/\/+/g, "/"),
      line: match.line,
      content: match.content,
    }));

    return {
      matches,
      truncated: result.truncated,
    };
  }

  private resolveRepo(path: string): SourceRepoPath {
    const normalized = normalizePath(path);
    if (!normalized.startsWith(`${SOURCE_ROOT}/`)) {
      throw new Error(`ENOENT: no such file or directory, open '${normalized}'`);
    }

    const parts = normalized.slice(`${SOURCE_ROOT}/`.length).split("/").filter(Boolean);
    if (parts.length === 0 || parts[0] !== SOURCE_ALIAS) {
      throw new Error(`ENOENT: no such file or directory, open '${normalized}'`);
    }

    return {
      repo: this.repo,
      relativePath: parts.slice(1).join("/"),
      absolutePath: normalized,
    };
  }
}

function readSourceRepo(config: SourceConfig): RipgitRepoRef | null {
  const owner = config.get("config/deploy/source_owner")?.trim() ?? "";
  const repo = config.get("config/deploy/source_repo")?.trim() ?? "";
  const ref = config.get("config/deploy/source_ref")?.trim() ?? "";

  if (!owner || !repo) {
    return null;
  }

  return {
    owner,
    repo,
    ...(ref ? { branch: ref } : {}),
  };
}

function makeDirStat(path: string): ExtendedMountStat {
  void path;
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
