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
  RepositorySummary,
  RepositoryTreeEntry,
  RepositoryVisibilityResult,
} from "./models";

const DEFAULT_COMMIT_PAGE_SIZE = 20;

type RepositoryWireValue = string | number | boolean | null | undefined | RepositoryWireValue[] | RepositoryWireRecord;
type RepositoryWireRecord = { [key: string]: RepositoryWireValue };
type RepositoryWirePayload = unknown;

export function normalizeRepositoryList(payload: RepositoryWirePayload): RepositorySummary[] {
  return asArray<RepositoryWireRecord>(asRecord(payload)?.repos)
    .map(normalizeRepositorySummary)
    .filter((repo): repo is RepositorySummary => repo !== null)
    .sort((left, right) => left.repo.localeCompare(right.repo));
}

export function normalizeRepositoryRefs(payload: RepositoryWirePayload, fallbackRepo: string): RepositoryRefs {
  const record = asRecord(payload);
  return {
    repo: asString(record?.repo) || fallbackRepo,
    heads: asStringRecord(record?.heads),
    tags: asStringRecord(record?.tags),
    remotes: asStringRecord(record?.remotes),
  };
}

export function normalizeRepositoryRead(payload: RepositoryWirePayload): RepositoryReadResult {
  const record = asRecord(payload);
  if (record?.kind === "tree") {
    return {
      repo: asString(record.repo),
      ref: asString(record.ref),
      path: asString(record.path),
      kind: "tree",
      entries: asArray<RepositoryWireRecord>(record.entries).map(normalizeTreeEntry),
    };
  }
  return {
    repo: asString(record?.repo),
    ref: asString(record?.ref),
    path: asString(record?.path),
    kind: "file",
    size: asNumber(record?.size),
    isBinary: record?.isBinary === true,
    content: asOptionalString(record?.content),
  };
}

export function normalizeRepositorySearch(payload: RepositoryWirePayload): RepositorySearchResult {
  const record = asRecord(payload);
  return {
    repo: asString(record?.repo),
    ref: asString(record?.ref),
    query: asString(record?.query),
    prefix: asString(record?.prefix) || undefined,
    truncated: record?.truncated === true,
    matches: asArray<RepositoryWireRecord>(record?.matches).map((match) => ({
      path: asString(match.path),
      line: asNumber(match.line),
      content: asString(match.content),
    })),
  };
}

export function normalizeRepositoryCommitsPage(
  payload: RepositoryWirePayload,
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
  const entries = asArray<RepositoryWireRecord>(record?.entries);
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

export function normalizeRepositoryDiff(payload: RepositoryWirePayload): RepositoryDiffResult {
  const record = asRecord(payload);
  return {
    repo: asString(record?.repo),
    commitHash: asString(record?.commitHash),
    parentHash: asString(record?.parentHash) || null,
    stats: normalizeStats(record?.stats),
    files: asArray<RepositoryWireRecord>(record?.files).map(normalizeDiffFile),
  };
}

export function normalizeRepositoryCompare(payload: RepositoryWirePayload): RepositoryCompareResult {
  const record = asRecord(payload);
  return {
    repo: asString(record?.repo),
    base: asString(record?.base),
    head: asString(record?.head),
    stats: normalizeStats(record?.stats),
    files: asArray<RepositoryWireRecord>(record?.files).map(normalizeDiffFile),
  };
}

export function normalizeRepositoryPull(payload: RepositoryWirePayload): RepositoryPullResult {
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
  if (upstreamChanged !== undefined) result.upstreamChanged = upstreamChanged;
  if (localChanged !== undefined) result.localChanged = localChanged;
  if (diverged !== undefined) result.diverged = diverged;
  return result;
}

export function normalizeRepositoryDelete(payload: RepositoryWirePayload, fallbackRepo: string): RepositoryDeleteResult {
  const record = asRecord(payload);
  return {
    repo: asString(record?.repo) || fallbackRepo,
    deleted: record?.deleted === true,
  };
}

export function normalizeRepositoryVisibility(payload: RepositoryWirePayload, fallbackRepo: string, fallbackPublic: boolean): RepositoryVisibilityResult {
  const record = asRecord(payload);
  return {
    repo: asString(record?.repo) || fallbackRepo,
    public: asOptionalBoolean(record?.public) ?? fallbackPublic,
    changed: record?.changed === true,
  };
}

function normalizeRepositorySummary(entry: RepositoryWireRecord): RepositorySummary | null {
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
    description: asString(entry.description) || undefined,
    updatedAt: asOptionalNumber(entry.updatedAt),
  };
}

function normalizeRepositoryKind(value: string): RepositoryKind {
  if (value === "home" || value === "user" || value === "workspace") {
    return value;
  }
  return "unknown";
}

function normalizeTreeEntry(entry: RepositoryWireRecord): RepositoryTreeEntry {
  const type = asString(entry.type);
  return {
    name: asString(entry.name),
    path: asString(entry.path),
    mode: asString(entry.mode),
    hash: asString(entry.hash),
    type: type === "tree" || type === "symlink" ? type : "blob",
  };
}

function normalizeCommit(entry: RepositoryWireRecord): RepositoryCommit {
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
    parents: asArray<string>(entry.parents),
  };
}

function normalizeDiffFile(file: RepositoryWireRecord): RepositoryDiffFile {
  const status = asString(file.status);
  return {
    path: asString(file.path),
    status: status === "added" || status === "deleted" ? status : "modified",
    oldHash: asString(file.oldHash) || undefined,
    newHash: asString(file.newHash) || undefined,
    hunks: asArray<RepositoryWireRecord>(file.hunks).map((hunk) => ({
      oldStart: asNumber(hunk.oldStart),
      oldCount: asNumber(hunk.oldCount),
      newStart: asNumber(hunk.newStart),
      newCount: asNumber(hunk.newCount),
      lines: asArray<RepositoryWireRecord>(hunk.lines).map((line) => ({
        tag: normalizeDiffLineTag(line.tag),
        content: asString(line.content),
      })),
    })),
  };
}

function normalizeStats(value: RepositoryWireValue): RepositoryDiffStats {
  const stats = asRecord(value);
  return {
    filesChanged: asNumber(stats?.filesChanged),
    additions: asNumber(stats?.additions),
    deletions: asNumber(stats?.deletions),
  };
}

function normalizeDiffLineTag(value: RepositoryWireValue): "context" | "add" | "delete" | "binary" {
  return value === "add" || value === "delete" || value === "binary" ? value : "context";
}

function asRecord(value: RepositoryWirePayload): RepositoryWireRecord | null {
  if (value === null || Array.isArray(value)) return null;
  // SAFETY: repository RPC payloads are decoded into the named wire value union at this boundary.
  return value as RepositoryWireRecord;
}

function asArray<T extends RepositoryWireValue>(value: RepositoryWireValue): T[] {
  if (!Array.isArray(value)) return [];
  // SAFETY: callers provide the expected repository wire element contract for each field.
  return value as T[];
}

function asString(value: RepositoryWireValue): string {
  if (value === null) return "";
  // SAFETY: repository scalar fields are normalized from the wire schema before use.
  return value as string;
}

function asOptionalString(value: RepositoryWireValue): string | null {
  if (value === null) return null;
  // SAFETY: optional string repository fields are decoded by the RPC boundary.
  return value as string;
}

function asStringRecord(value: RepositoryWireValue): Record<string, string> {
  const record = asRecord(value);
  if (!record) return {};
  // SAFETY: repository refs are defined as string-keyed string maps at the RPC boundary.
  return record as Record<string, string>;
}

function asNumber(value: RepositoryWireValue): number {
  // SAFETY: numeric repository fields are decoded by the RPC boundary.
  const numberValue = value as number;
  return Number.isFinite(numberValue) ? numberValue : 0;
}

function asOptionalNumber(value: RepositoryWireValue): number | undefined {
  // SAFETY: optional numeric repository fields are decoded by the RPC boundary.
  const numberValue = value as number;
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

function asOptionalBoolean(value: RepositoryWireValue): boolean | undefined {
  if (value === true || value === false) return value;
  return undefined;
}

function normalizeLimit(value: RepositoryWireValue): number {
  const numberValue = value as number;
  if (!Number.isFinite(numberValue) || numberValue <= 0) {
    return DEFAULT_COMMIT_PAGE_SIZE;
  }
  return Math.min(Math.floor(numberValue), 100);
}

function normalizeOffset(value: RepositoryWireValue): number {
  const numberValue = value as number;
  if (!Number.isFinite(numberValue) || numberValue <= 0) {
    return 0;
  }
  return Math.floor(numberValue);
}
