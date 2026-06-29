export type RepositoryKind = "home" | "package" | "user" | "workspace" | "unknown";

export type RepositorySourceSummary = {
  kind: "package" | "unknown";
  subdir: string;
  ref?: string;
  baseRef?: string;
  packageId?: string;
  name?: string;
  updatedAt?: number;
};

export type RepositorySummary = {
  repo: string;
  owner: string;
  name: string;
  kind: RepositoryKind;
  rawKind: string;
  writable: boolean;
  public: boolean;
  ref?: string;
  baseRef?: string;
  sources: RepositorySourceSummary[];
  description?: string;
  updatedAt?: number;
};

export type RepositoryRefs = {
  repo: string;
  heads: Record<string, string>;
  tags: Record<string, string>;
  remotes: Record<string, string>;
};

export type RepositoryTreeEntry = {
  name: string;
  path: string;
  mode: string;
  hash: string;
  type: "tree" | "blob" | "symlink";
};

export type RepositoryReadResult =
  | {
      repo: string;
      ref: string;
      path: string;
      kind: "tree";
      entries: RepositoryTreeEntry[];
    }
  | {
      repo: string;
      ref: string;
      path: string;
      kind: "file";
      size: number;
      isBinary: boolean;
      content: string | null;
    };

export type RepositorySearchMatch = {
  path: string;
  line: number;
  content: string;
};

export type RepositorySearchResult = {
  repo: string;
  ref: string;
  query: string;
  prefix?: string;
  truncated: boolean;
  matches: RepositorySearchMatch[];
};

export type RepositoryCommit = {
  hash: string;
  treeHash: string;
  author: string;
  authorEmail: string;
  authorTime: number;
  committer: string;
  committerEmail: string;
  commitTime: number;
  message: string;
  parents: string[];
};

export type RepositoryCommitsPage = {
  repo: string;
  ref: string;
  limit: number;
  offset: number;
  entries: RepositoryCommit[];
  hasNextPage: boolean;
};

export type RepositoryDiffLine = {
  tag: "context" | "add" | "delete" | "binary";
  content: string;
};

export type RepositoryDiffHunk = {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: RepositoryDiffLine[];
};

export type RepositoryDiffFile = {
  path: string;
  status: "added" | "deleted" | "modified";
  oldHash?: string;
  newHash?: string;
  hunks: RepositoryDiffHunk[];
};

export type RepositoryDiffStats = {
  filesChanged: number;
  additions: number;
  deletions: number;
};

export type RepositoryDiffResult = {
  repo: string;
  commitHash: string;
  parentHash: string | null;
  stats: RepositoryDiffStats;
  files: RepositoryDiffFile[];
};

export type RepositoryCompareResult = {
  repo: string;
  base: string;
  head: string;
  stats: RepositoryDiffStats;
  files: RepositoryDiffFile[];
};

export type RepositoryPullResult = {
  repo: string;
  ref: string;
  head: string | null;
  changed: boolean;
  remoteUrl: string;
  remoteRef: string;
  trackingRef?: string;
  upstreamHead?: string;
  upstreamChanged?: boolean;
  localChanged?: boolean;
  diverged?: boolean;
};
