import type {
  FileContent,
  MkdirOptions,
  RmOptions,
} from "just-bash";
import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import type { RepoSummary } from "@humansandmachines/gsv/protocol";
import type { InstalledPackageRecord } from "../../kernel/packages";
import type { ExtendedMountStat, FsSearchBackendResult, MountBackend } from "../mount";
import {
  RipgitClient,
  type RipgitApplyOp,
  type RipgitRepoRef,
} from "../ripgit/client";
import { normalizePath } from "../utils";

const TEXT_DECODER = new TextDecoder();
const TEXT_ENCODER = new TextEncoder();
const DEFAULT_REPO_REF = "main";

type SourceConfig = {
  get(key: string): string | null;
  set(key: string, value: string): void;
};

export type ProcessSourceBackendOptions = {
  identity: ProcessIdentity;
  storage?: R2Bucket | null;
  ripgit: RipgitClient | null;
  repos?: RepoSummary[] | null;
  processId?: string | null;
  config?: SourceConfig | null;
};

type SourcePackage = {
  record: InstalledPackageRecord;
  repo: string;
  sourceRef: string;
  sourceSubdir: string;
  resolvedCommit: string | null;
};

type SourceRepo = {
  owner: string;
  name: string;
  repo: string;
  rootPath: string;
  ref: string;
  baseRef: string;
  writable: boolean;
};

type SourceBranchState = {
  branch: string;
  baseRef: string;
  head: string | null;
  createdAt: number;
  updatedAt: number;
};

type SourceOverlayChange =
  | {
      type: "put";
      path: string;
      contentKey: string;
      size: number;
      updatedAt: number;
    }
  | {
      type: "delete";
      path: string;
      recursive: boolean;
      updatedAt: number;
    };

type SourceOverlayManifest = {
  version: 1;
  packageId: string;
  packageKey: string;
  baseRef: string;
  createdAt: number;
  updatedAt: number;
  changes: Record<string, SourceOverlayChange>;
};

export type SourceChangeSummary = {
  path: string;
  type: "put" | "delete";
  size?: number;
  recursive?: boolean;
  updatedAt: number;
};

export type RepoSourceStatus = {
  repo: string;
  sourceRef: string;
  baseRef: string;
  branch: string | null;
  head: string | null;
  changes: SourceChangeSummary[];
};

export type RepoSourceCommitResult = RepoSourceStatus & {
  committed: boolean;
  commitHead: string | null;
  ops: number;
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

export function packageSourcePathName(record: Pick<InstalledPackageRecord, "manifest">): string {
  return sanitizePackageSourcePathSegment(record.manifest.name);
}

export function packageSourceRepoPath(record: Pick<InstalledPackageRecord, "manifest">): string {
  const repo = normalizeRepoPath(record.manifest.source.repo);
  const subdir = normalizeRepoPath(record.manifest.source.subdir);
  const root = `/src/repos/${repo}`;
  return subdir ? `${root}/${subdir}` : root;
}

export function packageSourcePathNameMap<T extends Pick<InstalledPackageRecord, "packageId" | "scope" | "manifest">>(
  records: T[],
): Map<T, string> {
  const entries = records.map((record) => ({
    record,
    baseName: packageSourcePathName(record) || sanitizePackageSourcePathSegment(record.packageId) || "package",
  }));
  const counts = new Map<string, number>();
  for (const entry of entries) {
    counts.set(entry.baseName, (counts.get(entry.baseName) ?? 0) + 1);
  }

  const used = new Set<string>();
  const result = new Map<T, string>();
  for (const entry of entries.sort(compareSourcePathEntries)) {
    const collides = (counts.get(entry.baseName) ?? 0) > 1;
    const preferred = collides
      ? `${entry.baseName}--${packageSourcePathDisambiguator(entry.record)}`
      : entry.baseName;
    const name = uniquePackageSourcePathName(preferred, used);
    used.add(name);
    result.set(entry.record, name);
  }
  return result;
}

class ProcessSourceBackend implements MountBackend {
  private readonly identity: ProcessIdentity;
  private readonly storage: R2Bucket | null;
  private readonly ripgit: RipgitClient;
  private readonly repos: SourceRepo[];
  private readonly processId: string | null;
  private readonly config: SourceConfig | null;

  constructor(options: ProcessSourceBackendOptions) {
    this.identity = options.identity;
    this.storage = options.storage ?? null;
    this.ripgit = options.ripgit!;
    this.processId = options.processId ?? null;
    this.config = options.config ?? null;
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
    const repoResolved = this.resolveRepoPathOrNull(path);
    if (repoResolved) {
      return this.readRepoFileBuffer(repoResolved);
    }
    throwMissingSourcePath(path);
  }

  private async readRepoFileBuffer(resolved: {
    repo: SourceRepo;
    relativePath: string;
    normalizedPath: string;
  }): Promise<Uint8Array> {
    if (!resolved.relativePath) {
      throw new Error(`EISDIR: illegal operation on a directory, read '${resolved.normalizedPath}'`);
    }

    const overlayTarget = sourcePackageForRepo(resolved.repo);
    const overlay = await this.readOverlay(overlayTarget);
    const put = await this.readOverlayPut(overlay, resolved.relativePath);
    if (put) {
      return put;
    }
    if (isDeletedByOverlay(overlay, resolved.relativePath)) {
      throw new Error(`ENOENT: no such file or directory, open '${resolved.normalizedPath}'`);
    }

    const result = await this.ripgit.readPath(
      this.repoRefForSourceRepo(resolved.repo),
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
    const repoResolved = this.resolveWritableRepoPath(path, "write");
    await this.stageOverlayPut(sourcePackageForRepo(repoResolved.repo), repoResolved.relativePath, asBytes(content));
  }

  async appendFile(path: string, content: FileContent): Promise<void> {
    const repoResolved = this.resolveWritableRepoPath(path, "append");
    let current: Uint8Array<ArrayBufferLike> = new Uint8Array();
    if (await this.exists(path)) {
      current = await this.readFileBuffer(path);
    }
    const next = concatBytes(current, asBytes(content));
    await this.stageOverlayPut(sourcePackageForRepo(repoResolved.repo), repoResolved.relativePath, next);
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

    const repoResolved = this.resolveRepoPathOrNull(normalizedPath);
    if (repoResolved) {
      return this.statRepoPath(repoResolved);
    }
    throwMissingSourcePath(normalizedPath);
  }

  private async statRepoPath(resolved: {
    repo: SourceRepo;
    relativePath: string;
    normalizedPath: string;
  }): Promise<ExtendedMountStat> {
    if (!resolved.relativePath) {
      return makeDirectoryStat(this.identity.uid, this.identity.gid, resolved.repo.writable);
    }

    const overlayTarget = sourcePackageForRepo(resolved.repo);
    const overlay = await this.readOverlay(overlayTarget);
    const putChange = overlay.changes[resolved.relativePath];
    if (putChange?.type === "put") {
      return makeFileStat(this.identity.uid, this.identity.gid, putChange.size, resolved.repo.writable);
    }
    if (hasOverlayDescendant(overlay, resolved.relativePath)) {
      return makeDirectoryStat(this.identity.uid, this.identity.gid, resolved.repo.writable);
    }
    if (isDeletedByOverlay(overlay, resolved.relativePath)) {
      throw new Error(`ENOENT: no such file or directory, stat '${resolved.normalizedPath}'`);
    }

    const result = await this.ripgit.readPath(
      this.repoRefForSourceRepo(resolved.repo),
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
    const repoResolved = this.resolveRepoPath(path);
    if (!repoResolved.relativePath) {
      return;
    }
    this.assertWritableRepoPath(repoResolved, "mkdir");
    // ripgit tracks files, not empty directories. Directory creation is accepted
    // so normal shell workflows can create parents before writing files.
  }

  async readdir(path: string): Promise<string[]> {
    const normalizedPath = normalizePath(path);
    const virtualEntries = this.virtualDirectoryEntries(normalizedPath);
    if (virtualEntries) {
      return virtualEntries;
    }

    const repoResolved = this.resolveRepoPathOrNull(normalizedPath);
    if (repoResolved) {
      return this.readdirRepoPath(repoResolved);
    }
    throwMissingSourcePath(normalizedPath);
  }

  private async readdirRepoPath(resolved: {
    repo: SourceRepo;
    relativePath: string;
    normalizedPath: string;
  }): Promise<string[]> {
    const overlayTarget = sourcePackageForRepo(resolved.repo);
    const overlay = await this.readOverlay(overlayTarget);
    const putChange = overlay.changes[resolved.relativePath];
    if (putChange?.type === "put") {
      throw new Error(`ENOTDIR: not a directory, scandir '${resolved.normalizedPath}'`);
    }
    const deletedByOverlay = isDeletedByOverlay(overlay, resolved.relativePath);
    const hasStagedChildren = hasOverlayDescendant(overlay, resolved.relativePath);
    if (deletedByOverlay && !hasStagedChildren) {
      throw new Error(`ENOENT: no such file or directory, scandir '${resolved.normalizedPath}'`);
    }

    const entries = new Set<string>();
    if (!deletedByOverlay) {
      const result = await this.ripgit.readPath(
        this.repoRefForSourceRepo(resolved.repo),
        resolved.relativePath,
      );
      if (result.kind === "missing") {
        if (!resolved.relativePath) {
          return [];
        }
        if (!hasStagedChildren) {
          throw new Error(`ENOENT: no such file or directory, scandir '${resolved.normalizedPath}'`);
        }
      } else if (result.kind !== "tree") {
        throw new Error(`ENOTDIR: not a directory, scandir '${resolved.normalizedPath}'`);
      } else {
        for (const entry of result.entries) {
          entries.add(entry.name);
        }
      }
    }
    mergeOverlayDirectoryEntries(entries, overlay, resolved.relativePath);
    return [...entries].sort();
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    const repoResolved = this.resolveWritableRepoPath(path, "rm");
    const removable = await this.assertRemovableRepoPath(repoResolved, options);
    if (!removable) {
      return;
    }
    await this.stageOverlayDelete(sourcePackageForRepo(repoResolved.repo), repoResolved.relativePath, options?.recursive === true);
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

  async search(path: string, query: string): Promise<FsSearchBackendResult> {
    const normalizedPath = normalizePath(path);
    const virtualRepos = this.virtualDirectoryRepos(normalizedPath);
    if (virtualRepos) {
      const matches = [];
      let truncated = false;
      for (const repo of virtualRepos ?? []) {
        const result = await this.searchRepo(repo, "", query);
        matches.push(...result.matches);
        truncated = truncated || result.truncated === true;
      }
      return { matches, truncated };
    }

    const repoResolved = this.resolveRepoPathOrNull(normalizedPath);
    if (repoResolved) {
      return this.searchRepo(repoResolved.repo, repoResolved.relativePath, query);
    }
    throwMissingSourcePath(normalizedPath);
  }

  private async searchRepo(
    repo: SourceRepo,
    relativePath: string,
    query: string,
  ): Promise<FsSearchBackendResult> {
    const overlayTarget = sourcePackageForRepo(repo);
    const overlay = await this.readOverlay(overlayTarget);
    const result = await this.ripgit.search(
      this.repoRefForSourceRepo(repo),
      query,
      relativePath || undefined,
    );
    return {
      truncated: result.truncated,
      matches: [
        ...result.matches
          .filter((match) =>
            !overlayHasPut(overlay, match.path) &&
            !isDeletedByOverlay(overlay, match.path)
          )
          .map((match) => ({
            path: `${repo.rootPath}/${match.path}`.replace(/\/+$/g, ""),
            line: match.line,
            content: match.content,
          })),
        ...await this.searchOverlay(repo.rootPath, overlay, relativePath, query),
      ],
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
    const normalizedPath = normalizePath(path);
    const repo = this.repos.find((candidate) =>
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

  private virtualDirectoryEntries(path: string): string[] | null {
    const normalizedPath = normalizePath(path);
    if (normalizedPath !== "/src" && !normalizedPath.startsWith("/src/")) {
      return null;
    }
    if (this.repos.some((repo) => repo.rootPath === normalizedPath)) {
      return null;
    }
    const entries = new Set<string>();
    if (normalizedPath === "/src") {
      if (this.repos.length > 0) {
        entries.add("repos");
      }
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
    if (normalizedPath === "/src") {
      return this.repos;
    }
    if (normalizedPath === "/src/repos") {
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
    this.assertRepoPathWriteContext(resolved);
    return resolved;
  }

  private assertRepoPathWriteContext(
    resolved: {
      repo: SourceRepo;
      normalizedPath: string;
    },
  ): void {
    if (!resolved.repo.writable) {
      throw new Error(`EPERM: source repo is read-only '${resolved.normalizedPath}'`);
    }
    if (!this.processId) {
      throw new Error(`EPERM: repo writes require a process context '${resolved.normalizedPath}'`);
    }
    if (!this.storage) {
      throw new Error(`ENOSYS: repo overlay storage is unavailable '${resolved.normalizedPath}'`);
    }
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

  private repoRefForSourceRepo(repo: SourceRepo): RipgitRepoRef {
    const target = sourcePackageForRepo(repo);
    return {
      owner: repo.owner,
      repo: repo.name,
      branch: this.overlayBaseRef(target),
    };
  }

  private async readOverlay(pkg: SourcePackage): Promise<SourceOverlayManifest> {
    return readOverlayManifest(this.storage, this.processId, pkg, this.overlayBaseRef(pkg));
  }

  private overlayBaseRef(pkg: SourcePackage): string {
    return sourceBaseRefForPackage(pkg, this.readBranchState(pkg));
  }

  private async readOverlayPut(
    overlay: SourceOverlayManifest,
    relativePath: string,
  ): Promise<Uint8Array | null> {
    if (!this.storage) {
      return null;
    }
    const change = overlay.changes[relativePath];
    if (change?.type !== "put") {
      return null;
    }
    const obj = await this.storage.get(change.contentKey);
    if (!obj) {
      return null;
    }
    return new Uint8Array(await obj.arrayBuffer());
  }

  private async stageOverlayPut(
    pkg: SourcePackage,
    relativePath: string,
    content: Uint8Array,
  ): Promise<void> {
    const storage = this.storage!;
    const overlay = await this.readOverlay(pkg);
    const contentKey = overlayContentKey(this.processId!, pkg.record, relativePath);
    await storage.put(contentKey, content);
    const now = Date.now();
    overlay.changes[relativePath] = {
      type: "put",
      path: relativePath,
      contentKey,
      size: content.byteLength,
      updatedAt: now,
    };
    overlay.updatedAt = now;
    await writeOverlayManifest(storage, this.processId!, pkg, overlay);
  }

  private async stageOverlayDelete(
    pkg: SourcePackage,
    relativePath: string,
    recursive: boolean,
  ): Promise<void> {
    const storage = this.storage!;
    const overlay = await this.readOverlay(pkg);
    for (const change of sortedOverlayChanges(overlay)) {
      if (change.path === relativePath || (recursive && pathIsDescendant(change.path, relativePath))) {
        if (change.type === "put") {
          await storage.delete(change.contentKey);
        }
        delete overlay.changes[change.path];
      }
    }
    const now = Date.now();
    overlay.changes[relativePath] = {
      type: "delete",
      path: relativePath,
      recursive,
      updatedAt: now,
    };
    overlay.updatedAt = now;
    await writeOverlayManifest(storage, this.processId!, pkg, overlay);
  }

  private async searchOverlay(
    packageRoot: string,
    overlay: SourceOverlayManifest,
    relativePath: string,
    query: string,
  ): Promise<FsSearchBackendResult["matches"]> {
    const matches: FsSearchBackendResult["matches"] = [];
    for (const change of sortedOverlayChanges(overlay)) {
      if (change.type !== "put" || !pathIsWithin(change.path, relativePath)) {
        continue;
      }
      const bytes = await this.readOverlayPut(overlay, change.path);
      if (!bytes) {
        continue;
      }
      const text = TEXT_DECODER.decode(bytes);
      const lines = text.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        if (lines[index].includes(query)) {
          matches.push({
            path: `${packageRoot}/${change.path}`.replace(/\/+$/g, ""),
            line: index + 1,
            content: lines[index],
          });
        }
      }
    }
    return matches;
  }

  private readBranchState(pkg: SourcePackage): SourceBranchState | null {
    if (!this.config || !this.processId) {
      return null;
    }
    const raw = this.config.get(sourceBranchStateKey(this.processId, pkg.record));
    if (!raw) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<SourceBranchState>;
      if (typeof parsed.branch !== "string" || parsed.branch.trim().length === 0) {
        return null;
      }
      if (typeof parsed.baseRef !== "string" || parsed.baseRef.trim().length === 0) {
        return null;
      }
      return {
        branch: parsed.branch,
        baseRef: parsed.baseRef,
        head: typeof parsed.head === "string" ? parsed.head : null,
        createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : Date.now(),
        updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
      };
    } catch {
      return null;
    }
  }

}

export async function getRepoSourceStatus(
  options: ProcessSourceBackendOptions,
  repoSlug: string,
): Promise<RepoSourceStatus> {
  const repo = sourceRepoForOptions(options, repoSlug);
  const target = sourcePackageForRepo(repo);
  const state = readSourceBranchState(options.config ?? null, options.processId ?? null, target.record);
  const overlay = await readOverlayManifest(
    options.storage ?? null,
    options.processId ?? null,
    target,
    sourceBaseRefForPackage(target, state),
  );
  return sourceStatusForRepo(repo, overlay, state);
}

export async function diffRepoSourceChanges(
  options: ProcessSourceBackendOptions,
  repoSlug: string,
): Promise<string> {
  if (!options.ripgit) {
    throw new Error("RIPGIT binding is required");
  }
  const repo = sourceRepoForOptions(options, repoSlug);
  const target = sourcePackageForRepo(repo);
  const state = readSourceBranchState(options.config ?? null, options.processId ?? null, target.record);
  const overlay = await readOverlayManifest(
    options.storage ?? null,
    options.processId ?? null,
    target,
    sourceBaseRefForPackage(target, state),
  );
  const changes = sortedOverlayChanges(overlay);
  if (changes.length === 0) {
    return `No staged repo changes for ${repo.repo}\n`;
  }

  const repoRef = repoRefForOverlay(target, overlay.baseRef);
  const lines: string[] = [];
  for (const change of changes) {
    if (change.type === "delete") {
      lines.push(`D ${change.path}`);
      const base = await options.ripgit.readPath(repoRef, change.path);
      if (base.kind === "file") {
        lines.push(...formatSimpleDiff(change.path, base.bytes, null));
      }
      continue;
    }

    const bytes = await readOverlayContent(options.storage ?? null, change);
    if (!bytes) {
      continue;
    }
    const base = await options.ripgit.readPath(repoRef, change.path);
    if (base.kind === "file") {
      if (bytesEqual(base.bytes, bytes)) {
        continue;
      }
      lines.push(`M ${change.path}`);
      lines.push(...formatSimpleDiff(change.path, base.bytes, bytes));
    } else {
      lines.push(`A ${change.path}`);
      lines.push(...formatSimpleDiff(change.path, null, bytes));
    }
  }

  return lines.length > 0 ? `${lines.join("\n")}\n` : `No staged repo changes for ${repo.repo}\n`;
}

export async function commitRepoSourceChanges(
  options: ProcessSourceBackendOptions,
  repoSlug: string,
  args: { message: string; branch?: string },
): Promise<RepoSourceCommitResult> {
  if (!options.ripgit) {
    throw new Error("RIPGIT binding is required");
  }
  if (!options.storage) {
    throw new Error("Repo overlay storage is required");
  }
  if (!options.config) {
    throw new Error("Repo branch state storage is required");
  }
  if (!options.processId) {
    throw new Error("Repo changes require a process context");
  }
  const message = args.message.trim();
  if (!message) {
    throw new Error("message is required");
  }

  const repo = sourceRepoForOptions(options, repoSlug);
  if (!repo.writable) {
    throw new Error(`Repo is read-only: ${repo.repo}`);
  }
  const target = sourcePackageForRepo(repo);
  const state = readSourceBranchState(options.config, options.processId, target.record);
  const overlay = await readOverlayManifest(
    options.storage,
    options.processId,
    target,
    sourceBaseRefForPackage(target, state),
  );
  const explicitBranch = args.branch?.trim();
  const branch = explicitBranch
    ? normalizeSourceBranch(explicitBranch)
    : state?.branch ?? repo.ref;
  const requestedBranch = explicitBranch || (!state && repo.baseRef === repo.ref)
    ? branch
    : undefined;
  const repoRef = parseRepoSlug(repo.repo);
  const targetRef = await resolveSourceCommitTarget(options.ripgit, repoRef, branch, state, overlay, requestedBranch);
  const ops = await overlayApplyOps(options.storage, options.ripgit, target, overlay, targetRef.opsBaseRef);
  if (ops.length === 0) {
    const nextState = sourceBranchStateForTarget(state, branch, targetRef, null);
    writeSourceBranchState(options.config, options.processId, target.record, nextState);
    await discardOverlay(options.storage, options.processId, target, overlay);
    return {
      ...sourceStatusForRepo(repo, emptyOverlayManifest(target, sourceBaseRefForPackage(target, nextState)), nextState),
      committed: false,
      commitHead: nextState.head,
      ops: 0,
    };
  }

  const result = await options.ripgit.apply(
    { ...repoRef, branch },
    options.identity.username,
    `${options.identity.username}@gsv.local`,
    message,
    ops,
    {
      baseRef: targetRef.applyBaseRef,
      ...(targetRef.expectedHead ? { expectedHead: targetRef.expectedHead } : {}),
    },
  );
  const nextState = sourceBranchStateForTarget(state, branch, targetRef, result.head ?? null);
  writeSourceBranchState(options.config, options.processId, target.record, nextState);
  await discardOverlay(options.storage, options.processId, target, overlay);

  return {
    ...sourceStatusForRepo(repo, emptyOverlayManifest(target, sourceBaseRefForPackage(target, nextState)), nextState),
    committed: true,
    commitHead: nextState.head,
    ops: ops.length,
  };
}

export async function discardRepoSourceChanges(
  options: ProcessSourceBackendOptions,
  repoSlug: string,
): Promise<RepoSourceStatus> {
  if (!options.storage) {
    throw new Error("Repo overlay storage is required");
  }
  if (!options.processId) {
    throw new Error("Repo changes require a process context");
  }
  const repo = sourceRepoForOptions(options, repoSlug);
  const target = sourcePackageForRepo(repo);
  const state = readSourceBranchState(options.config ?? null, options.processId, target.record);
  const overlay = await readOverlayManifest(
    options.storage,
    options.processId,
    target,
    sourceBaseRefForPackage(target, state),
  );
  await discardOverlay(options.storage, options.processId, target, overlay);
  return sourceStatusForRepo(repo, emptyOverlayManifest(target, sourceBaseRefForPackage(target, state)), state);
}

function visibleSourceRepos(
  summaries?: RepoSummary[] | null,
): SourceRepo[] {
  const repos = new Map<string, SourceRepo>();
  for (const summary of summaries ?? []) {
    const parsed = sourceRepoForSummary(summary);
    if (!parsed) {
      continue;
    }
    repos.set(parsed.repo, parsed);
  }
  return [...repos.values()].sort((left, right) => {
    const owner = left.owner.localeCompare(right.owner);
    return owner !== 0 ? owner : left.name.localeCompare(right.name);
  });
}

function sourceRepoForSummary(summary: RepoSummary): SourceRepo | null {
  try {
    const parsed = parseRepoSlug(summary.repo || `${summary.owner}/${summary.name}`);
    const ref = sourceRefForSummary(summary);
    return {
      owner: parsed.owner,
      name: parsed.repo,
      repo: `${parsed.owner}/${parsed.repo}`,
      rootPath: `/src/repos/${parsed.owner}/${parsed.repo}`,
      ref,
      baseRef: sourceBaseRefForSummary(summary, ref),
      writable: summary.writable,
    };
  } catch {
    return null;
  }
}

function sourceRefForSummary(summary: RepoSummary): string {
  return typeof summary.ref === "string" && summary.ref.trim().length > 0
    ? summary.ref.trim()
    : DEFAULT_REPO_REF;
}

function sourceBaseRefForSummary(summary: RepoSummary, fallback: string): string {
  return typeof summary.baseRef === "string" && summary.baseRef.trim().length > 0
    ? summary.baseRef.trim()
    : fallback;
}

function throwMissingSourcePath(path: string): never {
  const normalizedPath = normalizePath(path);
  throw new Error(`ENOENT: no such source repo '${normalizedPath}'. Create repos with rgit create owner/repo and edit them under /src/repos/{owner}/{repo}.`);
}

function sourceRepoForOptions(
  options: ProcessSourceBackendOptions,
  repoSlug: string,
): SourceRepo {
  const normalizedRepo = normalizeRepoSlug(repoSlug);
  const repos = visibleSourceRepos(options.repos);
  const found = repos.find((repo) => repo.repo === normalizedRepo);
  if (!found) {
    throw new Error(`Repo is not visible: ${normalizedRepo}`);
  }
  return found;
}

function sourcePackageForRepo(repo: SourceRepo): SourcePackage {
  const record = {
    packageId: `repo:${repo.repo}`,
    scope: { kind: "global" },
    manifest: {
      name: repo.repo,
      source: {
        repo: repo.repo,
        ref: repo.ref,
        subdir: ".",
        resolvedCommit: repo.baseRef,
      },
    },
  } as InstalledPackageRecord;
  return {
    record,
    repo: repo.repo,
    sourceRef: repo.ref,
    sourceSubdir: ".",
    resolvedCommit: repo.baseRef,
  };
}

function compareSourcePathEntries<T extends Pick<InstalledPackageRecord, "packageId" | "scope" | "manifest">>(
  left: { record: T; baseName: string },
  right: { record: T; baseName: string },
): number {
  const name = left.baseName.localeCompare(right.baseName);
  if (name !== 0) {
    return name;
  }
  const source = sourcePathDisambiguationKey(left.record).localeCompare(sourcePathDisambiguationKey(right.record));
  if (source !== 0) {
    return source;
  }
  return packageSourceRecordKey(left.record).localeCompare(packageSourceRecordKey(right.record));
}

function packageSourcePathDisambiguator(record: Pick<InstalledPackageRecord, "packageId" | "manifest">): string {
  return sanitizePackageSourcePathSegment(sourcePathDisambiguationKey(record))
    || sanitizePackageSourcePathSegment(record.packageId)
    || "package";
}

function sourcePathDisambiguationKey(record: Pick<InstalledPackageRecord, "packageId" | "manifest">): string {
  const source = record.manifest.source;
  const subdir = normalizeRepoPath(source.subdir);
  return subdir && subdir !== "."
    ? `${source.repo}-${subdir}`
    : source.repo;
}

function sanitizePackageSourcePathSegment(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function uniquePackageSourcePathName(preferred: string, used: Set<string>): string {
  let candidate = preferred || "package";
  let index = 2;
  while (used.has(candidate)) {
    candidate = `${preferred || "package"}-${index}`;
    index += 1;
  }
  return candidate;
}

function packageSourceRecordKey(record: Pick<InstalledPackageRecord, "packageId" | "scope">): string {
  switch (record.scope.kind) {
    case "user":
      return `user:${record.scope.uid}:${record.packageId}`;
    case "global":
      return `global:${record.packageId}`;
  }
}

function sourceStatusForRepo(
  repo: SourceRepo,
  overlay: SourceOverlayManifest,
  explicitState?: SourceBranchState | null,
): RepoSourceStatus {
  return {
    repo: repo.repo,
    sourceRef: repo.ref,
    baseRef: explicitState?.baseRef ?? repo.baseRef,
    branch: explicitState?.branch ?? null,
    head: explicitState?.head ?? null,
    changes: sortedOverlayChanges(overlay).map((change) => ({
      path: change.path,
      type: change.type,
      ...(change.type === "put" ? { size: change.size } : { recursive: change.recursive }),
      updatedAt: change.updatedAt,
    })),
  };
}

function parseRepoSlug(raw: string): RipgitRepoRef {
  const [owner, repo, extra] = raw.trim().split("/");
  if (!owner || !repo || extra) {
    throw new Error(`Invalid package source repo: ${raw}`);
  }
  return { owner, repo };
}

function normalizeRepoSlug(raw: string): string {
  const parsed = parseRepoSlug(raw);
  return `${parsed.owner}/${parsed.repo}`;
}

function repoRefForOverlay(pkg: SourcePackage, baseRef: string): RipgitRepoRef {
  return {
    ...parseRepoSlug(pkg.repo),
    branch: baseRef,
  };
}

function sourceBaseRefForPackage(pkg: SourcePackage, state: SourceBranchState | null): string {
  return state?.head ?? pkg.resolvedCommit ?? pkg.sourceRef;
}

async function resolveSourceCommitTarget(
  ripgit: RipgitClient,
  repo: RipgitRepoRef,
  branch: string,
  state: SourceBranchState | null,
  overlay: SourceOverlayManifest,
  requestedBranch: string | undefined,
): Promise<{
  opsBaseRef: string;
  applyBaseRef: string;
  branchBaseRef: string;
  expectedHead: string | null;
}> {
  if (state?.branch === branch) {
    return {
      opsBaseRef: overlay.baseRef,
      applyBaseRef: overlay.baseRef,
      branchBaseRef: state.baseRef,
      expectedHead: state.head,
    };
  }

  if (requestedBranch?.trim()) {
    const refs = await ripgit.refs(repo);
    const targetHead = refs.heads?.[branch] ?? null;
    const targetBaseRef = targetHead ?? overlay.baseRef;
    return {
      opsBaseRef: targetBaseRef,
      applyBaseRef: targetBaseRef,
      branchBaseRef: targetBaseRef,
      expectedHead: targetHead,
    };
  }

  return {
    opsBaseRef: overlay.baseRef,
    applyBaseRef: overlay.baseRef,
    branchBaseRef: state?.baseRef ?? overlay.baseRef,
    expectedHead: null,
  };
}

function sourceBranchStateForTarget(
  previous: SourceBranchState | null,
  branch: string,
  target: {
    branchBaseRef: string;
    expectedHead: string | null;
  },
  resultHead: string | null,
): SourceBranchState {
  const now = Date.now();
  return {
    branch,
    baseRef: target.branchBaseRef,
    head: resultHead ?? target.expectedHead ?? (previous?.branch === branch ? previous.head : null),
    createdAt: previous?.branch === branch ? previous.createdAt : now,
    updatedAt: now,
  };
}

function sourceBranchStateKey(
  processId: string,
  record: Pick<InstalledPackageRecord, "packageId" | "scope">,
): string {
  return `process-source-branches/${encodeURIComponent(processId)}/${encodeURIComponent(packageSourceRecordKey(record))}`;
}

function readSourceBranchState(
  config: SourceConfig | null,
  processId: string | null,
  record: Pick<InstalledPackageRecord, "packageId" | "scope">,
): SourceBranchState | null {
  if (!config || !processId) {
    return null;
  }
  const raw = config.get(sourceBranchStateKey(processId, record));
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SourceBranchState>;
    if (typeof parsed.branch !== "string" || parsed.branch.trim().length === 0) {
      return null;
    }
    if (typeof parsed.baseRef !== "string" || parsed.baseRef.trim().length === 0) {
      return null;
    }
    return {
      branch: parsed.branch,
      baseRef: parsed.baseRef,
      head: typeof parsed.head === "string" ? parsed.head : null,
      createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : Date.now(),
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

function writeSourceBranchState(
  config: SourceConfig,
  processId: string,
  record: Pick<InstalledPackageRecord, "packageId" | "scope">,
  state: SourceBranchState,
): void {
  config.set(sourceBranchStateKey(processId, record), JSON.stringify(state));
}

function processBranchName(processId: string, packageName: string): string {
  return `gsv/process/${sanitizeBranchSegment(processId)}/${sanitizeBranchSegment(packageName)}`;
}

function normalizeSourceBranch(branch: string): string {
  const value = branch.startsWith("refs/heads/") ? branch.slice("refs/heads/".length) : branch;
  if (!/^[A-Za-z0-9._/-]+$/.test(value) || value.includes("..")) {
    throw new Error(`Invalid branch ref: ${branch}`);
  }
  return value;
}

async function readOverlayManifest(
  storage: R2Bucket | null,
  processId: string | null,
  pkg: SourcePackage,
  baseRef = sourceBaseRefForPackage(pkg, null),
): Promise<SourceOverlayManifest> {
  const empty = emptyOverlayManifest(pkg, baseRef);
  if (!storage || !processId) {
    return empty;
  }
  const obj = await storage.get(overlayManifestKey(processId, pkg.record));
  if (!obj) {
    return empty;
  }
  try {
    const parsed = JSON.parse(await obj.text()) as Partial<SourceOverlayManifest>;
    if (
      parsed.version !== 1 ||
      parsed.packageId !== pkg.record.packageId ||
      parsed.packageKey !== packageSourceRecordKey(pkg.record) ||
      !parsed.changes
    ) {
      return empty;
    }
    const changes: Record<string, SourceOverlayChange> = {};
    for (const [path, value] of Object.entries(parsed.changes)) {
      const normalizedPath = normalizeRepoPath(path);
      if (!normalizedPath || !value || typeof value !== "object") {
        continue;
      }
      const change = value as Partial<SourceOverlayChange>;
      if (change.type === "put" && typeof change.contentKey === "string") {
        changes[normalizedPath] = {
          type: "put",
          path: normalizedPath,
          contentKey: change.contentKey,
          size: typeof change.size === "number" ? change.size : 0,
          updatedAt: typeof change.updatedAt === "number" ? change.updatedAt : Date.now(),
        };
      } else if (change.type === "delete") {
        changes[normalizedPath] = {
          type: "delete",
          path: normalizedPath,
          recursive: change.recursive === true,
          updatedAt: typeof change.updatedAt === "number" ? change.updatedAt : Date.now(),
        };
      }
    }
    return {
      version: 1,
      packageId: pkg.record.packageId,
      packageKey: packageSourceRecordKey(pkg.record),
      baseRef: typeof parsed.baseRef === "string" && parsed.baseRef
        ? parsed.baseRef
        : empty.baseRef,
      createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : Date.now(),
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
      changes,
    };
  } catch {
    return empty;
  }
}

function emptyOverlayManifest(pkg: SourcePackage, baseRef = sourceBaseRefForPackage(pkg, null)): SourceOverlayManifest {
  const now = Date.now();
  return {
    version: 1,
    packageId: pkg.record.packageId,
    packageKey: packageSourceRecordKey(pkg.record),
    baseRef,
    createdAt: now,
    updatedAt: now,
    changes: {},
  };
}

async function writeOverlayManifest(
  storage: R2Bucket,
  processId: string,
  pkg: SourcePackage,
  overlay: SourceOverlayManifest,
): Promise<void> {
  const key = overlayManifestKey(processId, pkg.record);
  if (Object.keys(overlay.changes).length === 0) {
    await storage.delete(key);
    return;
  }
  await storage.put(key, `${JSON.stringify(overlay, null, 2)}\n`, {
    httpMetadata: { contentType: "application/json" },
  });
}

async function discardOverlay(
  storage: R2Bucket,
  processId: string,
  pkg: SourcePackage,
  overlay: SourceOverlayManifest,
): Promise<void> {
  const keys = sortedOverlayChanges(overlay)
    .flatMap((change) => change.type === "put" ? [change.contentKey] : []);
  if (keys.length > 0) {
    await storage.delete(keys);
  }
  await storage.delete(overlayManifestKey(processId, pkg.record));
}

function overlayManifestKey(
  processId: string,
  record: Pick<InstalledPackageRecord, "packageId" | "scope">,
): string {
  return `process-source-overlays/${encodeURIComponent(processId)}/${encodeURIComponent(packageSourceRecordKey(record))}/manifest.json`;
}

function overlayContentKey(
  processId: string,
  record: Pick<InstalledPackageRecord, "packageId" | "scope">,
  relativePath: string,
): string {
  return `process-source-overlays/${encodeURIComponent(processId)}/${encodeURIComponent(packageSourceRecordKey(record))}/files/${encodeURIComponent(relativePath)}`;
}

function sortedOverlayChanges(overlay: SourceOverlayManifest): SourceOverlayChange[] {
  return Object.values(overlay.changes).sort((left, right) => left.path.localeCompare(right.path));
}

function overlayHasPut(overlay: SourceOverlayManifest, path: string): boolean {
  return overlay.changes[normalizeRepoPath(path)]?.type === "put";
}

function isDeletedByOverlay(overlay: SourceOverlayManifest, path: string): boolean {
  const normalizedPath = normalizeRepoPath(path);
  const exact = overlay.changes[normalizedPath];
  if (exact?.type === "delete") {
    return true;
  }
  for (const change of Object.values(overlay.changes)) {
    if (change.type === "delete" && change.recursive && pathIsWithin(normalizedPath, change.path)) {
      return true;
    }
  }
  return false;
}

function hasOverlayDescendant(overlay: SourceOverlayManifest, path: string): boolean {
  const normalizedPath = normalizeRepoPath(path);
  return Object.values(overlay.changes).some((change) =>
    change.type === "put" && pathIsDescendant(change.path, normalizedPath)
  );
}

function mergeOverlayDirectoryEntries(
  entries: Set<string>,
  overlay: SourceOverlayManifest,
  directoryPath: string,
): void {
  const normalizedDirectory = normalizeRepoPath(directoryPath);
  for (const change of sortedOverlayChanges(overlay)) {
    const child = childNameWithin(change.path, normalizedDirectory);
    if (!child) {
      continue;
    }
    if (change.type === "delete") {
      if (isDirectChild(change.path, normalizedDirectory)) {
        entries.delete(child);
      }
      continue;
    }
    entries.add(child);
  }
}

function isDirectChild(path: string, directoryPath: string): boolean {
  const normalizedPath = normalizeRepoPath(path);
  const normalizedDirectory = normalizeRepoPath(directoryPath);
  const relativePath = normalizedDirectory
    ? normalizedPath.startsWith(`${normalizedDirectory}/`)
      ? normalizedPath.slice(normalizedDirectory.length + 1)
      : ""
    : normalizedPath;
  return relativePath.length > 0 && !relativePath.includes("/");
}

function childNameWithin(path: string, directoryPath: string): string | null {
  const normalizedPath = normalizeRepoPath(path);
  const normalizedDirectory = normalizeRepoPath(directoryPath);
  if (!normalizedDirectory) {
    return normalizedPath.split("/", 1)[0] || null;
  }
  if (!normalizedPath.startsWith(`${normalizedDirectory}/`)) {
    return null;
  }
  return normalizedPath.slice(normalizedDirectory.length + 1).split("/", 1)[0] || null;
}

function pathIsWithin(path: string, maybeParent: string): boolean {
  const normalizedPath = normalizeRepoPath(path);
  const normalizedParent = normalizeRepoPath(maybeParent);
  return !normalizedParent || normalizedPath === normalizedParent || normalizedPath.startsWith(`${normalizedParent}/`);
}

function pathIsDescendant(path: string, maybeParent: string): boolean {
  const normalizedPath = normalizeRepoPath(path);
  const normalizedParent = normalizeRepoPath(maybeParent);
  return !normalizedParent ? normalizedPath.length > 0 : normalizedPath.startsWith(`${normalizedParent}/`);
}

async function readOverlayContent(
  storage: R2Bucket | null,
  change: Extract<SourceOverlayChange, { type: "put" }>,
): Promise<Uint8Array | null> {
  if (!storage) {
    return null;
  }
  const obj = await storage.get(change.contentKey);
  if (!obj) {
    return null;
  }
  return new Uint8Array(await obj.arrayBuffer());
}

async function overlayApplyOps(
  storage: R2Bucket,
  ripgit: RipgitClient,
  pkg: SourcePackage,
  overlay: SourceOverlayManifest,
  baseRef = overlay.baseRef,
): Promise<RipgitApplyOp[]> {
  const repoRef = repoRefForOverlay(pkg, baseRef);
  const ops: RipgitApplyOp[] = [];
  for (const change of sortedOverlayChanges(overlay)) {
    const repoPath = joinRepoPath(pkg.sourceSubdir, change.path);
    const base = await ripgit.readPath(repoRef, repoPath);
    if (change.type === "delete") {
      if (base.kind !== "missing") {
        ops.push({ type: "delete", path: repoPath, recursive: change.recursive });
      }
      continue;
    }
    const bytes = await readOverlayContent(storage, change);
    if (!bytes) {
      continue;
    }
    if (base.kind === "file" && bytesEqual(base.bytes, bytes)) {
      continue;
    }
    ops.push({
      type: "put",
      path: repoPath,
      contentBytes: Array.from(bytes),
    });
  }
  return ops;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function formatSimpleDiff(path: string, before: Uint8Array | null, after: Uint8Array | null): string[] {
  if ((before && isProbablyBinary(before)) || (after && isProbablyBinary(after))) {
    return [`Binary files differ: ${path}`];
  }
  const lines = [
    `--- ${before ? `a/${path}` : "/dev/null"}`,
    `+++ ${after ? `b/${path}` : "/dev/null"}`,
  ];
  for (const line of before ? TEXT_DECODER.decode(before).split("\n") : []) {
    if (line.length > 0) {
      lines.push(`-${line}`);
    }
  }
  for (const line of after ? TEXT_DECODER.decode(after).split("\n") : []) {
    if (line.length > 0) {
      lines.push(`+${line}`);
    }
  }
  return lines;
}

function isProbablyBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, Math.min(bytes.byteLength, 1024)).includes(0);
}

function sanitizeBranchSegment(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "source";
}

function normalizeRepoPath(path: string | null | undefined): string {
  return String(path ?? "")
    .trim()
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".")
    .join("/");
}

function joinRepoPath(base: string, relativePath: string): string {
  const normalizedBase = normalizeRepoPath(base);
  const normalizedRelative = normalizeRepoPath(relativePath);
  if (!normalizedBase || normalizedBase === ".") {
    return normalizedRelative;
  }
  if (!normalizedRelative) {
    return normalizedBase;
  }
  return `${normalizedBase}/${normalizedRelative}`;
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
  if (typeof content === "string") {
    return TEXT_ENCODER.encode(content);
  }
  return content;
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const output = new Uint8Array(left.length + right.length);
  output.set(left, 0);
  output.set(right, left.length);
  return output;
}
