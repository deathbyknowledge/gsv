import type { JsonValue } from "@humansandmachines/gsv/protocol";
import { z } from "zod";
import type {
  RepositoryCommit,
  RepositoryCommitsPage,
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

const stringField = z.string().catch("");
const optionalStringField = z.string().optional().catch(undefined);
const nullableStringField = z.union([z.string(), z.null()]).catch(null);
const numberField = z.number().finite().catch(0);
const optionalNumberField = z.number().finite().optional().catch(undefined);
const booleanField = z.boolean().catch(false);
const optionalBooleanField = z.boolean().optional().catch(undefined);
const stringMapField = z.record(z.string(), z.string()).catch({});

const repositorySummaryWireSchema = z.looseObject({
  repo: stringField,
  owner: stringField,
  name: stringField,
  kind: stringField,
  writable: booleanField,
  public: booleanField,
  ref: optionalStringField,
  baseRef: optionalStringField,
  description: optionalStringField,
  updatedAt: optionalNumberField,
});

const repositoryListWireSchema = z.looseObject({
  repos: z.array(repositorySummaryWireSchema).catch([]),
}).catch({ repos: [] });

const repositoryRefsWireSchema = z.looseObject({
  repo: stringField,
  heads: stringMapField,
  tags: stringMapField,
  remotes: stringMapField,
}).catch({ repo: "", heads: {}, tags: {}, remotes: {} });

const repositoryTreeEntryWireSchema = z.looseObject({
  name: stringField,
  path: stringField,
  mode: stringField,
  hash: stringField,
  type: stringField,
});

const repositoryReadWireSchema = z.looseObject({
  repo: stringField,
  ref: stringField,
  path: stringField,
  kind: stringField,
  entries: z.array(repositoryTreeEntryWireSchema).catch([]),
  size: numberField,
  isBinary: booleanField,
  content: nullableStringField,
}).catch({
  repo: "",
  ref: "",
  path: "",
  kind: "file",
  entries: [],
  size: 0,
  isBinary: false,
  content: null,
});

const repositorySearchMatchWireSchema = z.looseObject({
  path: stringField,
  line: numberField,
  content: stringField,
});

const repositorySearchWireSchema = z.looseObject({
  repo: stringField,
  ref: stringField,
  query: stringField,
  prefix: optionalStringField,
  truncated: booleanField,
  matches: z.array(repositorySearchMatchWireSchema).catch([]),
}).catch({
  repo: "",
  ref: "",
  query: "",
  truncated: false,
  matches: [],
});

const repositoryCommitWireSchema = z.looseObject({
  hash: stringField,
  treeHash: stringField,
  author: stringField,
  authorEmail: stringField,
  authorTime: numberField,
  committer: stringField,
  committerEmail: stringField,
  commitTime: numberField,
  message: stringField,
  parents: z.array(z.string()).catch([]),
});

const repositoryCommitsWireSchema = z.looseObject({
  repo: stringField,
  ref: stringField,
  entries: z.array(repositoryCommitWireSchema).catch([]),
}).catch({ repo: "", ref: "", entries: [] });

const repositoryStatsWireSchema = z.looseObject({
  filesChanged: numberField,
  additions: numberField,
  deletions: numberField,
}).catch({ filesChanged: 0, additions: 0, deletions: 0 });

const repositoryDiffLineWireSchema = z.looseObject({
  tag: stringField,
  content: stringField,
});

const repositoryDiffHunkWireSchema = z.looseObject({
  oldStart: numberField,
  oldCount: numberField,
  newStart: numberField,
  newCount: numberField,
  lines: z.array(repositoryDiffLineWireSchema).catch([]),
});

const repositoryDiffFileWireSchema = z.looseObject({
  path: stringField,
  status: stringField,
  oldHash: optionalStringField,
  newHash: optionalStringField,
  hunks: z.array(repositoryDiffHunkWireSchema).catch([]),
});

const repositoryDiffWireSchema = z.looseObject({
  repo: stringField,
  commitHash: stringField,
  parentHash: nullableStringField,
  stats: repositoryStatsWireSchema,
  files: z.array(repositoryDiffFileWireSchema).catch([]),
}).catch({
  repo: "",
  commitHash: "",
  parentHash: null,
  stats: { filesChanged: 0, additions: 0, deletions: 0 },
  files: [],
});

const repositoryCompareWireSchema = z.looseObject({
  repo: stringField,
  base: stringField,
  head: stringField,
  stats: repositoryStatsWireSchema,
  files: z.array(repositoryDiffFileWireSchema).catch([]),
}).catch({
  repo: "",
  base: "",
  head: "",
  stats: { filesChanged: 0, additions: 0, deletions: 0 },
  files: [],
});

const repositoryPullWireSchema = z.looseObject({
  repo: stringField,
  ref: stringField,
  head: nullableStringField,
  changed: booleanField,
  remoteUrl: optionalStringField,
  remote_url: optionalStringField,
  remoteRef: optionalStringField,
  remote_ref: optionalStringField,
  trackingRef: optionalStringField,
  tracking_ref: optionalStringField,
  upstreamHead: optionalStringField,
  upstream_head: optionalStringField,
  upstreamChanged: optionalBooleanField,
  upstream_changed: optionalBooleanField,
  localChanged: optionalBooleanField,
  local_changed: optionalBooleanField,
  diverged: optionalBooleanField,
}).catch({ repo: "", ref: "", head: null, changed: false });

const repositoryDeleteWireSchema = z.looseObject({
  repo: stringField,
  deleted: booleanField,
}).catch({ repo: "", deleted: false });

const repositoryVisibilityWireSchema = z.looseObject({
  repo: stringField,
  public: optionalBooleanField,
  changed: booleanField,
}).catch({ repo: "", changed: false });

export function normalizeRepositoryList(payload: JsonValue): RepositorySummary[] {
  return repositoryListWireSchema.parse(payload).repos
    .map(normalizeRepositorySummary)
    .filter((repo): repo is RepositorySummary => repo !== null)
    .sort((left, right) => left.repo.localeCompare(right.repo));
}

export function normalizeRepositoryRefs(
  payload: JsonValue,
  fallbackRepo: string,
): RepositoryRefs {
  const record = repositoryRefsWireSchema.parse(payload);
  return { ...record, repo: record.repo || fallbackRepo };
}

export function normalizeRepositoryRead(payload: JsonValue): RepositoryReadResult {
  const record = repositoryReadWireSchema.parse(payload);
  if (record.kind === "tree") {
    return {
      repo: record.repo,
      ref: record.ref,
      path: record.path,
      kind: "tree",
      entries: record.entries.map(normalizeTreeEntry),
    };
  }
  return {
    repo: record.repo,
    ref: record.ref,
    path: record.path,
    kind: "file",
    size: record.size,
    isBinary: record.isBinary,
    content: record.content,
  };
}

export function normalizeRepositorySearch(payload: JsonValue): RepositorySearchResult {
  return repositorySearchWireSchema.parse(payload);
}

export function normalizeRepositoryCommitsPage(
  payload: JsonValue,
  fallbackRepo: string,
  fallbackRef: string,
  requestedLimit: number,
  requestedOffset: number,
): RepositoryCommitsPage {
  const record = repositoryCommitsWireSchema.parse(payload);
  const limit = normalizeLimit(requestedLimit);
  return {
    repo: record.repo || fallbackRepo,
    ref: record.ref || fallbackRef,
    limit,
    offset: normalizeOffset(requestedOffset),
    entries: record.entries.slice(0, limit).map(normalizeCommit),
    hasNextPage: record.entries.length > limit,
  };
}

export function normalizeRepositoryDiff(payload: JsonValue): RepositoryDiffResult {
  const record = repositoryDiffWireSchema.parse(payload);
  return {
    ...record,
    stats: normalizeStats(record.stats),
    files: record.files.map(normalizeDiffFile),
  };
}

export function normalizeRepositoryCompare(
  payload: JsonValue,
): RepositoryCompareResult {
  const record = repositoryCompareWireSchema.parse(payload);
  return {
    ...record,
    stats: normalizeStats(record.stats),
    files: record.files.map(normalizeDiffFile),
  };
}

export function normalizeRepositoryPull(payload: JsonValue): RepositoryPullResult {
  const record = repositoryPullWireSchema.parse(payload);
  const result: RepositoryPullResult = {
    repo: record.repo,
    ref: record.ref,
    head: record.head,
    changed: record.changed,
    remoteUrl: record.remoteUrl || record.remote_url || "",
    remoteRef: record.remoteRef || record.remote_ref || "",
  };
  const trackingRef = record.trackingRef || record.tracking_ref;
  const upstreamHead = record.upstreamHead || record.upstream_head;
  const upstreamChanged = record.upstreamChanged ?? record.upstream_changed;
  const localChanged = record.localChanged ?? record.local_changed;
  if (trackingRef) result.trackingRef = trackingRef;
  if (upstreamHead) result.upstreamHead = upstreamHead;
  if (upstreamChanged !== undefined) result.upstreamChanged = upstreamChanged;
  if (localChanged !== undefined) result.localChanged = localChanged;
  if (record.diverged !== undefined) result.diverged = record.diverged;
  return result;
}

export function normalizeRepositoryDelete(
  payload: JsonValue,
  fallbackRepo: string,
): RepositoryDeleteResult {
  const record = repositoryDeleteWireSchema.parse(payload);
  return { repo: record.repo || fallbackRepo, deleted: record.deleted };
}

export function normalizeRepositoryVisibility(
  payload: JsonValue,
  fallbackRepo: string,
  fallbackPublic: boolean,
): RepositoryVisibilityResult {
  const record = repositoryVisibilityWireSchema.parse(payload);
  return {
    repo: record.repo || fallbackRepo,
    public: record.public ?? fallbackPublic,
    changed: record.changed,
  };
}

function normalizeRepositorySummary(
  entry: z.output<typeof repositorySummaryWireSchema>,
): RepositorySummary | null {
  if (!entry.repo || !entry.owner || !entry.name) return null;
  return {
    repo: entry.repo,
    owner: entry.owner,
    name: entry.name,
    kind: normalizeRepositoryKind(entry.kind),
    rawKind: entry.kind,
    writable: entry.writable,
    public: entry.public,
    ref: entry.ref || undefined,
    baseRef: entry.baseRef || undefined,
    description: entry.description || undefined,
    updatedAt: entry.updatedAt,
  };
}

function normalizeRepositoryKind(value: string): RepositoryKind {
  if (value === "home" || value === "user" || value === "workspace") {
    return value;
  }
  return "unknown";
}

function normalizeTreeEntry(
  entry: z.output<typeof repositoryTreeEntryWireSchema>,
): RepositoryTreeEntry {
  return {
    name: entry.name,
    path: entry.path,
    mode: entry.mode,
    hash: entry.hash,
    type: entry.type === "tree" || entry.type === "symlink" ? entry.type : "blob",
  };
}

function normalizeCommit(
  entry: z.output<typeof repositoryCommitWireSchema>,
): RepositoryCommit {
  return entry;
}

function normalizeDiffFile(
  file: z.output<typeof repositoryDiffFileWireSchema>,
): RepositoryDiffFile {
  return {
    path: file.path,
    status: file.status === "added" || file.status === "deleted"
      ? file.status
      : "modified",
    oldHash: file.oldHash || undefined,
    newHash: file.newHash || undefined,
    hunks: file.hunks.map((hunk) => ({
      oldStart: hunk.oldStart,
      oldCount: hunk.oldCount,
      newStart: hunk.newStart,
      newCount: hunk.newCount,
      lines: hunk.lines.map((line) => ({
        tag: normalizeDiffLineTag(line.tag),
        content: line.content,
      })),
    })),
  };
}

function normalizeStats(
  value: z.output<typeof repositoryStatsWireSchema>,
): RepositoryDiffStats {
  return value;
}

function normalizeDiffLineTag(
  value: string,
): "context" | "add" | "delete" | "binary" {
  return value === "add" || value === "delete" || value === "binary"
    ? value
    : "context";
}

function normalizeLimit(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_COMMIT_PAGE_SIZE;
  return Math.min(Math.floor(value), 100);
}

function normalizeOffset(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}
