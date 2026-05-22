import type {
  CreateSourceRepoArgs,
  CreateSourceRepoResult,
  DiffSourceRepoArgs,
  LoadSourceCommitsArgs,
  LoadSourcesStateArgs,
  PullSourceRepoArgs,
  SearchSourceRepoArgs,
  SetSourceRepoPublicArgs,
  SourceCommit,
  SourceCommitsPage,
  SourceDiffFile,
  SourceDiffResult,
  SourceReadResult,
  SourceRefs,
  SourceRepoRecord,
  SourcesState,
  SourceSearchResult,
  SourceTreeEntry,
} from "../app/features/sources/types";

const DEFAULT_COMMIT_PAGE_SIZE = 20;
const MAX_COMMIT_PAGE_SIZE = 100;

type KernelClientLike = {
  request(method: string, payload?: unknown): Promise<unknown>;
};

type PackageLike = {
  packageId: string;
  name: string;
  enabled: boolean;
  source: {
    repo: string;
    subdir: string;
  };
  review: {
    required: boolean;
    approvedAt: number | null;
  };
};

type KernelSourceRepoKind = Exclude<SourceRepoRecord["kind"], "multi-package">;

export async function loadSourcesState(
  args: LoadSourcesStateArgs | undefined,
  kernel: KernelClientLike,
): Promise<SourcesState> {
  const [repoResult, packages] = await Promise.all([
    kernel.request("repo.list", {}),
    listPackages(kernel),
  ]);
  const repos = asArray<Record<string, unknown>>(asRecord(repoResult)?.repos)
    .map((repo) => normalizeRepo(repo, packages))
    .filter((repo): repo is SourceRepoRecord => repo !== null)
    .sort((left, right) => left.repo.localeCompare(right.repo));
  const requestedRepo = asString(args?.repo);
  const selectedRepo = repos.find((repo) => repo.repo === requestedRepo)
    ?? (args?.selectFirst === true ? repos[0] : null)
    ?? null;
  if (!selectedRepo) {
    return {
      repos,
      selectedRepo: null,
      refs: null,
      read: null,
      commits: [],
      commitsPage: null,
    };
  }

  const refs = await loadSourceRefs(kernel, selectedRepo.repo, asString(args?.ref));
  const path = normalizeRepoPath(args?.path);
  const [read, commitsPage] = await Promise.all([
    readSourceRepo(kernel, {
      repo: selectedRepo.repo,
      ref: refs.activeRef,
      path,
    }),
    loadSourceCommits(kernel, {
      repo: selectedRepo.repo,
      ref: refs.activeRef,
      limit: args?.commitLimit,
      offset: args?.commitOffset,
    }),
  ]);

  return {
    repos,
    selectedRepo,
    refs,
    read,
    commits: commitsPage.commits,
    commitsPage,
  };
}

export async function loadSourceCommits(
  kernel: KernelClientLike,
  args: LoadSourceCommitsArgs,
): Promise<SourceCommitsPage> {
  const repo = asString(args?.repo);
  const ref = asString(args?.ref) || "main";
  const limit = normalizeLimit(args?.limit);
  const offset = normalizeOffset(args?.offset);
  if (!repo) throw new Error("repo is required");
  const result = asRecord(await kernel.request("repo.log", {
    repo,
    ref,
    limit: limit + 1,
    offset,
  }));
  const entries = asArray<Record<string, unknown>>(result?.entries);
  const commits = entries.slice(0, limit).map(normalizeCommit);
  return {
    repo: asString(result?.repo) || repo,
    ref: asString(result?.ref) || ref,
    limit,
    offset,
    commits,
    hasNextPage: entries.length > limit,
  };
}

export async function searchSourceRepo(
  kernel: KernelClientLike,
  args: SearchSourceRepoArgs,
): Promise<SourceSearchResult> {
  const repo = asString(args?.repo);
  const query = asString(args?.query).trim();
  if (!repo) throw new Error("repo is required");
  if (!query) throw new Error("query is required");
  const result = asRecord(await kernel.request("repo.search", {
    repo,
    ref: asString(args?.ref) || undefined,
    query,
    prefix: normalizeRepoPath(args?.prefix) || undefined,
  }));
  return {
    repo: asString(result?.repo),
    ref: asString(result?.ref),
    query: asString(result?.query),
    prefix: asString(result?.prefix) || undefined,
    truncated: result?.truncated === true,
    matches: asArray<Record<string, unknown>>(result?.matches).map((match) => ({
      path: asString(match.path),
      line: asNumber(match.line),
      content: asString(match.content),
    })),
  };
}

export async function diffSourceRepo(
  kernel: KernelClientLike,
  args: DiffSourceRepoArgs,
): Promise<SourceDiffResult> {
  const repo = asString(args?.repo);
  const commit = asString(args?.commit);
  if (!repo) throw new Error("repo is required");
  if (!commit) throw new Error("commit is required");
  const result = asRecord(await kernel.request("repo.diff", {
    repo,
    commit,
    context: typeof args?.context === "number" ? args.context : 3,
  }));
  return {
    repo: asString(result?.repo),
    commitHash: asString(result?.commitHash),
    parentHash: asString(result?.parentHash) || null,
    stats: normalizeStats(result?.stats),
    files: asArray<Record<string, unknown>>(result?.files).map(normalizeDiffFile),
  };
}

export async function pullSourceRepo(kernel: KernelClientLike, args: PullSourceRepoArgs): Promise<unknown> {
  const repo = asString(args?.repo);
  const ref = asString(args?.ref) || "main";
  if (!repo) throw new Error("repo is required");
  return kernel.request("repo.import", {
    repo,
    ref,
    remoteRef: ref,
  });
}

export async function setSourceRepoPublic(
  kernel: KernelClientLike,
  args: SetSourceRepoPublicArgs,
): Promise<unknown> {
  const repo = asString(args?.repo);
  if (!repo) throw new Error("repo is required");
  return kernel.request("pkg.public.set", {
    repo,
    public: args?.public === true,
  });
}

export async function createSourceRepo(
  kernel: KernelClientLike,
  args: CreateSourceRepoArgs,
): Promise<CreateSourceRepoResult> {
  const repo = asString(args?.repo);
  if (!repo) throw new Error("repo is required");
  const result = asRecord(await kernel.request("repo.create", {
    repo,
    ref: asString(args?.ref) || undefined,
    description: asString(args?.description) || undefined,
  }));
  return {
    repo: asString(result?.repo),
    ref: asString(result?.ref),
    head: asString(result?.head) || null,
    created: result?.created === true,
  };
}

async function loadSourceRefs(kernel: KernelClientLike, repo: string, requestedRef: string): Promise<SourceRefs> {
  const result = asRecord(await kernel.request("repo.refs", { repo }));
  const heads = asStringRecord(result?.heads);
  const tags = asStringRecord(result?.tags);
  const remotes = asStringRecord(result?.remotes);
  return {
    repo: asString(result?.repo) || repo,
    activeRef: chooseRef(requestedRef, heads, tags, remotes),
    heads,
    tags,
    ...(Object.keys(remotes).length > 0 ? { remotes } : {}),
  };
}

async function readSourceRepo(
  kernel: KernelClientLike,
  args: { repo: string; ref: string; path: string },
): Promise<SourceReadResult> {
  const result = asRecord(await kernel.request("repo.read", {
    repo: args.repo,
    ref: args.ref,
    path: args.path || undefined,
  }));
  if (result?.kind === "tree") {
    return {
      repo: asString(result.repo),
      ref: asString(result.ref),
      path: asString(result.path),
      kind: "tree",
      entries: asArray<Record<string, unknown>>(result.entries).map(normalizeTreeEntry),
    };
  }
  return {
    repo: asString(result?.repo),
    ref: asString(result?.ref),
    path: asString(result?.path),
    kind: "file",
    size: asNumber(result?.size),
    isBinary: result?.isBinary === true,
    content: typeof result?.content === "string" ? result.content : null,
  };
}

async function listPackages(kernel: KernelClientLike): Promise<PackageLike[]> {
  try {
    const result = asRecord(await kernel.request("pkg.list", {}));
    return asArray<PackageLike>(result?.packages);
  } catch {
    return [];
  }
}

function normalizeRepo(entry: Record<string, unknown>, packages: PackageLike[]): SourceRepoRecord | null {
  const repo = asString(entry.repo);
  const owner = asString(entry.owner);
  const name = asString(entry.name);
  const kind = asString(entry.kind);
  if (!repo || !owner || !name || !isSourceRepoKind(kind)) {
    return null;
  }
  const linkedPackages = packages
    .filter((pkg) => pkg.source.repo === repo)
    .map((pkg) => ({
      packageId: pkg.packageId,
      name: pkg.name,
      subdir: pkg.source.subdir,
      enabled: pkg.enabled,
      reviewPending: pkg.review.required && !pkg.review.approvedAt,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const sourceKind = kind === "package" && linkedPackages.length > 1 ? "multi-package" : kind;
  return {
    repo,
    owner,
    name,
    kind: sourceKind,
    writable: entry.writable === true,
    public: entry.public === true,
    description: asString(entry.description) || undefined,
    updatedAt: asOptionalNumber(entry.updatedAt),
    linkedPackages,
  };
}

function normalizeTreeEntry(entry: Record<string, unknown>): SourceTreeEntry {
  const type = asString(entry.type);
  return {
    name: asString(entry.name),
    path: asString(entry.path),
    mode: asString(entry.mode),
    hash: asString(entry.hash),
    type: type === "tree" || type === "symlink" ? type : "blob",
  };
}

function normalizeCommit(entry: Record<string, unknown>): SourceCommit {
  return {
    hash: asString(entry.hash),
    treeHash: asString(entry.treeHash),
    author: asString(entry.author),
    commitTime: asNumber(entry.commitTime),
    message: asString(entry.message),
    parents: asArray<string>(entry.parents),
  };
}

function normalizeDiffFile(file: Record<string, unknown>): SourceDiffFile {
  const status = asString(file.status);
  return {
    path: asString(file.path),
    status: status === "added" || status === "deleted" ? status : "modified",
    oldHash: asString(file.oldHash) || undefined,
    newHash: asString(file.newHash) || undefined,
    hunks: asArray<Record<string, unknown>>(file.hunks).map((hunk) => ({
      oldStart: asNumber(hunk.oldStart),
      oldCount: asNumber(hunk.oldCount),
      newStart: asNumber(hunk.newStart),
      newCount: asNumber(hunk.newCount),
      lines: asArray<Record<string, unknown>>(hunk.lines).map((line) => ({
        tag: normalizeDiffLineTag(line.tag),
        content: asString(line.content),
      })),
    })),
  };
}

function normalizeStats(value: unknown): SourceDiffResult["stats"] {
  const stats = asRecord(value);
  return {
    filesChanged: asNumber(stats?.filesChanged),
    additions: asNumber(stats?.additions),
    deletions: asNumber(stats?.deletions),
  };
}

function normalizeDiffLineTag(value: unknown): "context" | "add" | "delete" | "binary" {
  return value === "add" || value === "delete" || value === "binary" ? value : "context";
}

function chooseRef(
  requestedRef: string,
  heads: Record<string, string>,
  tags: Record<string, string>,
  remotes: Record<string, string>,
): string {
  const requestedRemote = requestedRef.startsWith("refs/remotes/")
    ? requestedRef.slice("refs/remotes/".length)
    : requestedRef;
  if (requestedRef && (heads[requestedRef] || tags[requestedRef] || remotes[requestedRemote])) {
    return requestedRef;
  }
  if (heads.main) return "main";
  const [firstHead] = Object.keys(heads).sort((left, right) => left.localeCompare(right));
  if (firstHead) return firstHead;
  const [firstTag] = Object.keys(tags).sort((left, right) => left.localeCompare(right));
  return firstTag ?? "main";
}

function normalizeRepoPath(path: string | undefined): string {
  const raw = typeof path === "string" ? path.trim() : "";
  const parts: string[] = [];
  for (const segment of raw.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === ".." || segment.includes("\0")) {
      throw new Error(`Invalid repo path: ${path}`);
    }
    parts.push(segment);
  }
  return parts.join("/");
}

function isSourceRepoKind(value: string): value is KernelSourceRepoKind {
  return value === "home" || value === "workspace" || value === "package" || value === "user";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asStringRecord(value: unknown): Record<string, string> {
  const record = asRecord(value) ?? {};
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === "string") {
      result[key] = item;
    }
  }
  return result;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_COMMIT_PAGE_SIZE;
  }
  return Math.min(Math.floor(value), MAX_COMMIT_PAGE_SIZE);
}

function normalizeOffset(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.floor(value);
}
