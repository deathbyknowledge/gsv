import type {
  FileContent,
  MkdirOptions,
  RmOptions,
} from "just-bash";
import type {
  ProcessIdentity,
  RepoSummary,
} from "@humansandmachines/gsv/protocol";
import type { ExtendedMountStat, FsSearchBackendResult, MountBackend } from "../mount";
import {
  RipgitClient,
  type RipgitApplyOp,
  type RipgitRepoRef,
} from "../ripgit/client";
import { concatBytes, normalizePath } from "../utils";

const TEXT_DECODER = new TextDecoder();
const TEXT_ENCODER = new TextEncoder();
const DEFAULT_REPO_REF = "main";

export type ProcessSourceBackendOptions = {
  identity: ProcessIdentity;
  ripgit: RipgitClient | null;
  repos?: RepoSummary[] | null;
};

type SourceRepo = {
  owner: string;
  name: string;
  repo: string;
  rootPath: string;
  ref: string;
  writable: boolean;
};

export function createProcessSourceBackend(
  options: ProcessSourceBackendOptions,
): MountBackend | null {
  if (!options.ripgit) {
    return null;
  }

  return new ProcessSourceBackend(options);
}

export function isProcessSourcePath(path: string): boolean {
  const normalized = normalizePath(path);
  return normalized === "/src" || normalized.startsWith("/src/");
}

class ProcessSourceBackend implements MountBackend {
  private readonly identity: ProcessIdentity;
  private readonly ripgit: RipgitClient;
  private readonly repos: SourceRepo[];

  constructor(options: ProcessSourceBackendOptions) {
    if (!options.ripgit) {
      throw new Error("Process source backend requires ripgit");
    }
    this.identity = options.identity;
    this.ripgit = options.ripgit;
    this.repos = visibleSourceRepos(options.repos);
  }

  handles(path: string): boolean {
    return isProcessSourcePath(path);
  }

  async readFile(path: string): Promise<string> {
    const bytes = await this.readFileBuffer(path);
    return TEXT_DECODER.decode(bytes);
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const resolved = this.resolveRepoPathOrNull(path);
    if (!resolved) {
      throwMissingSourcePath(path);
    }
    if (!resolved.relativePath) {
      throw new Error(`EISDIR: illegal operation on a directory, read '${resolved.normalizedPath}'`);
    }

    const result = await this.ripgit.readPath(
      repoRefForSourceRepo(resolved.repo),
      resolved.relativePath,
    );
    if (result.kind === "missing") {
      throw new Error(`ENOENT: no such file or directory, open '${resolved.normalizedPath}'`);
    }
    if (result.kind === "tree") {
      throw new Error(`EISDIR: illegal operation on a directory, read '${resolved.normalizedPath}'`);
    }
    return result.bytes;
  }

  async writeFile(path: string, content: FileContent): Promise<void> {
    const resolved = this.resolveWritableRepoPath(path, "write");
    await this.applyRepoOps(
      resolved.repo,
      `gsv: write ${resolved.relativePath}`,
      [{
        type: "put",
        path: resolved.relativePath,
        contentBytes: Array.from(asBytes(content)),
      }],
    );
  }

  async appendFile(path: string, content: FileContent): Promise<void> {
    const resolved = this.resolveWritableRepoPath(path, "append");
    let current: Uint8Array<ArrayBufferLike> = new Uint8Array();
    if (await this.exists(path)) {
      current = await this.readFileBuffer(path);
    }
    const next = concatBytes(current, asBytes(content));
    await this.applyRepoOps(
      resolved.repo,
      `gsv: append ${resolved.relativePath}`,
      [{
        type: "put",
        path: resolved.relativePath,
        contentBytes: Array.from(next),
      }],
    );
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
    if (this.virtualDirectoryEntries(normalizedPath)) {
      return makeDirectoryStat(this.identity.uid, this.identity.gid, true);
    }

    const resolved = this.resolveRepoPathOrNull(normalizedPath);
    if (!resolved) {
      throwMissingSourcePath(normalizedPath);
    }
    if (!resolved.relativePath) {
      return makeDirectoryStat(this.identity.uid, this.identity.gid, resolved.repo.writable);
    }

    const result = await this.ripgit.readPath(
      repoRefForSourceRepo(resolved.repo),
      resolved.relativePath,
    );
    if (result.kind === "missing") {
      throw new Error(`ENOENT: no such file or directory, stat '${resolved.normalizedPath}'`);
    }
    if (result.kind === "tree") {
      return makeDirectoryStat(this.identity.uid, this.identity.gid, resolved.repo.writable);
    }
    return makeFileStat(this.identity.uid, this.identity.gid, result.size, resolved.repo.writable);
  }

  async mkdir(path: string, _options?: MkdirOptions): Promise<void> {
    const resolved = this.resolveRepoPath(path);
    if (!resolved.relativePath) {
      return;
    }
    this.assertWritableRepoPath(resolved, "mkdir");
    // ripgit tracks files, not empty directories. Directory creation is accepted
    // so normal shell workflows can create parents before writing files.
  }

  async readdir(path: string): Promise<string[]> {
    const normalizedPath = normalizePath(path);
    const virtualEntries = this.virtualDirectoryEntries(normalizedPath);
    if (virtualEntries) {
      return virtualEntries;
    }

    const resolved = this.resolveRepoPathOrNull(normalizedPath);
    if (!resolved) {
      throwMissingSourcePath(normalizedPath);
    }
    const result = await this.ripgit.readPath(
      repoRefForSourceRepo(resolved.repo),
      resolved.relativePath,
    );
    if (result.kind === "missing") {
      if (!resolved.relativePath) {
        return [];
      }
      throw new Error(`ENOENT: no such file or directory, scandir '${resolved.normalizedPath}'`);
    }
    if (result.kind !== "tree") {
      throw new Error(`ENOTDIR: not a directory, scandir '${resolved.normalizedPath}'`);
    }
    return result.entries.map((entry) => entry.name).sort();
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    const resolved = this.resolveWritableRepoPath(path, "rm");
    if (!await this.assertRemovableRepoPath(resolved, options)) {
      return;
    }
    await this.applyRepoOps(
      resolved.repo,
      `gsv: rm ${resolved.relativePath}`,
      [{
        type: "delete",
        path: resolved.relativePath,
        recursive: options?.recursive === true,
      }],
    );
  }

  async chmod(path: string): Promise<void> {
    throw new Error(`EPERM: source path modes are managed by ripgit '${normalizePath(path)}'`);
  }

  async chown(path: string): Promise<void> {
    throw new Error(`EPERM: source path ownership is managed by ripgit '${normalizePath(path)}'`);
  }

  async utimes(path: string): Promise<void> {
    const normalizedPath = normalizePath(path);
    if (await this.exists(normalizedPath)) {
      return;
    }
    throw new Error(`ENOENT: no such file or directory, utimes '${normalizedPath}'`);
  }

  async search(
    path: string,
    query: string,
    _include?: string,
    signal?: AbortSignal,
  ): Promise<FsSearchBackendResult> {
    signal?.throwIfAborted();
    const normalizedPath = normalizePath(path);
    const virtualRepos = this.virtualDirectoryRepos(normalizedPath);
    if (virtualRepos) {
      const matches = [];
      let truncated = false;
      for (const repo of virtualRepos) {
        signal?.throwIfAborted();
        const result = await this.searchRepo(repo, "", query, signal);
        matches.push(...result.matches);
        truncated ||= result.truncated === true;
      }
      return { matches, truncated };
    }

    const resolved = this.resolveRepoPathOrNull(normalizedPath);
    if (!resolved) {
      throwMissingSourcePath(normalizedPath);
    }
    return this.searchRepo(resolved.repo, resolved.relativePath, query, signal);
  }

  private async searchRepo(
    repo: SourceRepo,
    relativePath: string,
    query: string,
    signal?: AbortSignal,
  ): Promise<FsSearchBackendResult> {
    signal?.throwIfAborted();
    const result = await this.ripgit.search(
      repoRefForSourceRepo(repo),
      query,
      relativePath || undefined,
      signal,
    );
    signal?.throwIfAborted();
    return {
      truncated: result.truncated,
      matches: result.matches.map((match) => ({
        path: `${repo.rootPath}/${match.path}`.replace(/\/+$/g, ""),
        line: match.line,
        content: match.content,
      })),
    };
  }

  private resolveRepoPath(path: string): {
    repo: SourceRepo;
    relativePath: string;
    normalizedPath: string;
  } {
    const resolved = this.resolveRepoPathOrNull(path);
    if (!resolved) {
      throw new Error(`ENOENT: no such source repo '${normalizePath(path)}'`);
    }
    return resolved;
  }

  private resolveRepoPathOrNull(path: string): {
    repo: SourceRepo;
    relativePath: string;
    normalizedPath: string;
  } | null {
    return resolveSourceRepoPath(this.repos, path);
  }

  private virtualDirectoryEntries(path: string): string[] | null {
    const normalizedPath = normalizePath(path);
    if (normalizedPath !== "/src" && !normalizedPath.startsWith("/src/")) {
      return null;
    }
    if (this.repos.some((repo) => repo.rootPath === normalizedPath)) {
      return null;
    }
    const entries = new Set<string>();
    if (normalizedPath === "/src" && this.repos.length > 0) {
      entries.add("repos");
    }
    if (normalizedPath === "/src/repos") {
      for (const repo of this.repos) {
        entries.add(repo.owner);
      }
    } else {
      const ownerMatch = normalizedPath.match(/^\/src\/repos\/([^/]+)$/);
      if (ownerMatch) {
        for (const repo of this.repos) {
          if (repo.owner === ownerMatch[1]) {
            entries.add(repo.name);
          }
        }
      }
    }
    if (
      normalizedPath === "/src" ||
      normalizedPath === "/src/repos" ||
      entries.size > 0
    ) {
      return [...entries].sort();
    }
    return null;
  }

  private virtualDirectoryRepos(path: string): SourceRepo[] | null {
    const normalizedPath = normalizePath(path);
    const entries = this.virtualDirectoryEntries(normalizedPath);
    if (!entries) {
      return null;
    }
    if (normalizedPath === "/src" || normalizedPath === "/src/repos") {
      return this.repos;
    }
    const ownerMatch = normalizedPath.match(/^\/src\/repos\/([^/]+)$/);
    if (ownerMatch) {
      return this.repos.filter((repo) => repo.owner === ownerMatch[1]);
    }
    return [];
  }

  private resolveWritableRepoPath(path: string, operation: string): {
    repo: SourceRepo;
    relativePath: string;
    normalizedPath: string;
  } {
    return this.assertWritableRepoPath(this.resolveRepoPath(path), operation);
  }

  private assertWritableRepoPath(
    resolved: {
      repo: SourceRepo;
      relativePath: string;
      normalizedPath: string;
    },
    operation: string,
  ): {
    repo: SourceRepo;
    relativePath: string;
    normalizedPath: string;
  } {
    if (!resolved.relativePath) {
      throw new Error(`EISDIR: illegal operation on a directory, ${operation} '${resolved.normalizedPath}'`);
    }
    if (!resolved.repo.writable) {
      throw new Error(`EPERM: source repo is read-only '${resolved.normalizedPath}'`);
    }
    return resolved;
  }

  private async assertRemovableRepoPath(
    resolved: {
      repo: SourceRepo;
      relativePath: string;
      normalizedPath: string;
    },
    options?: RmOptions,
  ): Promise<boolean> {
    try {
      const stat = await this.stat(resolved.normalizedPath);
      if (stat.isDirectory && !options?.recursive) {
        const entries = await this.readdir(resolved.normalizedPath);
        if (entries.length > 0) {
          throw new Error(`ENOTEMPTY: directory not empty, rmdir '${resolved.normalizedPath}'`);
        }
      }
    } catch (error) {
      if (options?.force && error instanceof Error && error.message.includes("ENOENT")) {
        return false;
      }
      throw error;
    }
    return true;
  }

  private async applyRepoOps(
    repo: SourceRepo,
    message: string,
    ops: RipgitApplyOp[],
  ): Promise<void> {
    const result = await this.ripgit.apply(
      repoRefForSourceRepo(repo),
      this.identity.username,
      `${this.identity.username}@gsv.local`,
      message,
      ops,
    );
    if (result.conflict) {
      throw new Error(`Repo ref moved while committing ${repo.repo}`);
    }
  }
}

function visibleSourceRepos(summaries?: RepoSummary[] | null): SourceRepo[] {
  const repos = new Map<string, SourceRepo>();
  for (const summary of summaries ?? []) {
    const parsed = sourceRepoForSummary(summary);
    if (parsed) {
      repos.set(parsed.repo, parsed);
    }
  }
  return [...repos.values()].sort((left, right) => left.repo.localeCompare(right.repo));
}

function sourceRepoForSummary(summary: RepoSummary): SourceRepo | null {
  try {
    const parsed = parseRepoSlug(summary.repo || `${summary.owner}/${summary.name}`);
    return {
      owner: parsed.owner,
      name: parsed.repo,
      repo: `${parsed.owner}/${parsed.repo}`,
      rootPath: `/src/repos/${parsed.owner}/${parsed.repo}`,
      ref: summary.ref?.trim() || DEFAULT_REPO_REF,
      writable: summary.writable,
    };
  } catch {
    return null;
  }
}

function resolveSourceRepoPath(repos: SourceRepo[], path: string): {
  repo: SourceRepo;
  relativePath: string;
  normalizedPath: string;
} | null {
  const normalizedPath = normalizePath(path);
  const repo = repos.find((candidate) =>
    normalizedPath === candidate.rootPath || normalizedPath.startsWith(`${candidate.rootPath}/`)
  );
  if (!repo) {
    return null;
  }
  return {
    repo,
    relativePath: normalizedPath === repo.rootPath
      ? ""
      : normalizeRepoPath(normalizedPath.slice(repo.rootPath.length + 1)),
    normalizedPath,
  };
}

function parseRepoSlug(raw: string) {
  const [owner, repo, extra] = raw.trim().split("/");
  if (!owner || !repo || extra) {
    throw new Error(`Invalid source repo: ${raw}`);
  }
  return { owner, repo };
}

function repoRefForSourceRepo(repo: SourceRepo): RipgitRepoRef {
  return {
    owner: repo.owner,
    repo: repo.name,
    branch: repo.ref,
  };
}

function throwMissingSourcePath(path: string): never {
  const normalizedPath = normalizePath(path);
  throw new Error(`ENOENT: no such source repo '${normalizedPath}'. Create repos with rgit create owner/repo and edit them under /src/repos/{owner}/{repo}.`);
}

function normalizeRepoPath(path: string | null | undefined): string {
  return String(path ?? "")
    .trim()
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".")
    .join("/");
}

function makeDirectoryStat(uid: number, gid: number, writable: boolean): ExtendedMountStat {
  return {
    isFile: false,
    isDirectory: true,
    isSymbolicLink: false,
    mode: writable ? 0o755 : 0o555,
    size: 0,
    mtime: new Date(),
    uid,
    gid,
  };
}

function makeFileStat(uid: number, gid: number, size: number, writable: boolean): ExtendedMountStat {
  return {
    isFile: true,
    isDirectory: false,
    isSymbolicLink: false,
    mode: writable ? 0o644 : 0o444,
    size,
    mtime: new Date(),
    uid,
    gid,
  };
}

function asBytes(content: FileContent): Uint8Array {
  return content instanceof Uint8Array ? content : TEXT_ENCODER.encode(content);
}
