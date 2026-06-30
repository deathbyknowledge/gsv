import type {
  RepositoryCommit,
  RepositoryCompareResult,
  RepositoryDeleteResult,
  RepositoryDiffFile,
  RepositoryDiffResult,
  RepositoryDiffStats,
  RepositoryKind,
  RepositoryPullResult,
  RepositoryReadResult,
  RepositoryRefs,
  RepositorySearchResult,
  RepositorySourceSummary,
  RepositorySummary,
  RepositoryTreeEntry,
} from "./models";

const DEFAULT_COMMIT_PAGE_SIZE = 20;

export function normalizeRepositoryList(payload: unknown): RepositorySummary[] {
  return asArray<Record<string, unknown>>(asRecord(payload)?.repos)
    .map(normalizeRepositorySummary)
    .filter((repo): repo is RepositorySummary => repo !== null)
    .sort((left, right) => left.repo.localeCompare(right.repo));
}

export function normalizeRepositoryRefs(payload: unknown, fallbackRepo: string): RepositoryRefs {
  const record = asRecord(payload);
  return {
    repo: asString(record?.repo) || fallbackRepo,
    heads: asStringRecord(record?.heads),
    tags: asStringRecord(record?.tags),
    remotes: asStringRecord(record?.remotes),
  };
}

export function normalizeRepositoryRead(payload: unknown): RepositoryReadResult {
  const record = asRecord(payload);
  if (record?.kind === "tree") {
    return {
      repo: asString(record.repo),
      ref: asString(record.ref),
      path: asString(record.path),
      kind: "tree",
      entries: asArray<Record<string, unknown>>(record.entries).map(normalizeTreeEntry),
    };
  }
  return {
    repo: asString(record?.repo),
    ref: asString(record?.ref),
    path: asString(record?.path),
    kind: "file",
    size: asNumber(record?.size),
    isBinary: record?.isBinary === true,
    content: typeof record?.content === "string" ? record.content : null,
  };
}

export function normalizeRepositorySearch(payload: unknown): RepositorySearchResult {
  const record = asRecord(payload);
  return {
    repo: asString(record?.repo),
    ref: asString(record?.ref),
    query: asString(record?.query),
    prefix: asString(record?.prefix) || undefined,
    truncated: record?.truncated === true,
    matches: asArray<Record<string, unknown>>(record?.matches).map((match) => ({
      path: asString(match.path),
      line: asNumber(match.line),
      content: asString(match.content),
    })),
  };
}

export function normalizeRepositoryCommitsPage(
  payload: unknown,
  fallbackRepo: string,
  fallbackRef: string,
  requestedLimit: number,
  requestedOffset: number,
): {
  repo: string;
  ref: string;
  limit: number;
  offset: number;
  entries: RepositoryCommit[];
  hasNextPage: boolean;
} {
  const record = asRecord(payload);
  const entries = asArray<Record<string, unknown>>(record?.entries);
  const limit = normalizeLimit(requestedLimit);
  return {
    repo: asString(record?.repo) || fallbackRepo,
    ref: asString(record?.ref) || fallbackRef,
    limit,
    offset: normalizeOffset(requestedOffset),
    entries: entries.slice(0, limit).map(normalizeCommit),
    hasNextPage: entries.length > limit,
  };
}

export function normalizeRepositoryDiff(payload: unknown): RepositoryDiffResult {
  const record = asRecord(payload);
  return {
    repo: asString(record?.repo),
    commitHash: asString(record?.commitHash),
    parentHash: asString(record?.parentHash) || null,
    stats: normalizeStats(record?.stats),
    files: asArray<Record<string, unknown>>(record?.files).map(normalizeDiffFile),
  };
}

export function normalizeRepositoryCompare(payload: unknown): RepositoryCompareResult {
  const record = asRecord(payload);
  return {
    repo: asString(record?.repo),
    base: asString(record?.base),
    head: asString(record?.head),
    stats: normalizeStats(record?.stats),
    files: asArray<Record<string, unknown>>(record?.files).map(normalizeDiffFile),
  };
}

export function normalizeRepositoryPull(payload: unknown): RepositoryPullResult {
  const record = asRecord(payload);
  const result: RepositoryPullResult = {
    repo: asString(record?.repo),
    ref: asString(record?.ref),
    head: asString(record?.head) || null,
    changed: record?.changed === true,
    remoteUrl: asString(record?.remoteUrl) || asString(record?.remote_url),
    remoteRef: asString(record?.remoteRef) || asString(record?.remote_ref),
  };
  const trackingRef = asString(record?.trackingRef) || asString(record?.tracking_ref);
  const upstreamHead = asString(record?.upstreamHead) || asString(record?.upstream_head);
  const upstreamChanged = asOptionalBoolean(record?.upstreamChanged ?? record?.upstream_changed);
  const localChanged = asOptionalBoolean(record?.localChanged ?? record?.local_changed);
  const diverged = record?.diverged;
  if (trackingRef) result.trackingRef = trackingRef;
  if (upstreamHead) result.upstreamHead = upstreamHead;
  if (typeof upstreamChanged === "boolean") result.upstreamChanged = upstreamChanged;
  if (typeof localChanged === "boolean") result.localChanged = localChanged;
  if (typeof diverged === "boolean") result.diverged = diverged;
  return result;
}

export function normalizeRepositoryDelete(payload: unknown, fallbackRepo: string): RepositoryDeleteResult {
  const record = asRecord(payload);
  return {
    repo: asString(record?.repo) || fallbackRepo,
    deleted: record?.deleted === true,
  };
}

function normalizeRepositorySummary(entry: Record<string, unknown>): RepositorySummary | null {
  const repo = asString(entry.repo);
  const owner = asString(entry.owner);
  const name = asString(entry.name);
  if (!repo || !owner || !name) {
    return null;
  }

  const rawKind = asString(entry.kind);
  return {
    repo,
    owner,
    name,
    kind: normalizeRepositoryKind(rawKind),
    rawKind,
    writable: entry.writable === true,
    public: entry.public === true,
    ref: asString(entry.ref) || undefined,
    baseRef: asString(entry.baseRef) || undefined,
    sources: asArray<Record<string, unknown>>(entry.sources).map(normalizeSourceSummary),
    description: asString(entry.description) || undefined,
    updatedAt: asOptionalNumber(entry.updatedAt),
  };
}

function normalizeSourceSummary(entry: Record<string, unknown>): RepositorySourceSummary {
  const kind = asString(entry.kind);
  return {
    kind: kind === "package" ? "package" : "unknown",
    subdir: asString(entry.subdir) || ".",
    ref: asString(entry.ref) || undefined,
    baseRef: asString(entry.baseRef) || undefined,
    packageId: asString(entry.packageId) || undefined,
    name: asString(entry.name) || undefined,
    updatedAt: asOptionalNumber(entry.updatedAt),
  };
}

function normalizeRepositoryKind(value: string): RepositoryKind {
  if (value === "home" || value === "package" || value === "user" || value === "workspace") {
    return value;
  }
  return "unknown";
}

function normalizeTreeEntry(entry: Record<string, unknown>): RepositoryTreeEntry {
  const type = asString(entry.type);
  return {
    name: asString(entry.name),
    path: asString(entry.path),
    mode: asString(entry.mode),
    hash: asString(entry.hash),
    type: type === "tree" || type === "symlink" ? type : "blob",
  };
}

function normalizeCommit(entry: Record<string, unknown>): RepositoryCommit {
  return {
    hash: asString(entry.hash),
    treeHash: asString(entry.treeHash),
    author: asString(entry.author),
    authorEmail: asString(entry.authorEmail),
    authorTime: asNumber(entry.authorTime),
    committer: asString(entry.committer),
    committerEmail: asString(entry.committerEmail),
    commitTime: asNumber(entry.commitTime),
    message: asString(entry.message),
    parents: asArray<string>(entry.parents).filter((parent) => typeof parent === "string"),
  };
}

function normalizeDiffFile(file: Record<string, unknown>): RepositoryDiffFile {
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

function normalizeStats(value: unknown): RepositoryDiffStats {
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
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string") {
      result[key] = value;
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

function asOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizeLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_COMMIT_PAGE_SIZE;
  }
  return Math.min(Math.floor(value), 100);
}

function normalizeOffset(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.floor(value);
}
