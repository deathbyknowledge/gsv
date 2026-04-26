export type RepoSummary = {
  repo: string;
  owner: string;
  name: string;
  kind: "home" | "workspace" | "package" | "user";
  writable: boolean;
  public: boolean;
  description?: string;
  updatedAt?: number;
};

export type RepoListArgs = {
  owner?: string;
};

export type RepoListResult = {
  repos: RepoSummary[];
};

export type RepoCreateArgs = {
  repo: string;
  ref?: string;
  description?: string;
};

export type RepoCreateResult = {
  repo: string;
  ref: string;
  head: string | null;
  created: boolean;
};

export type RepoRefsArgs = {
  repo: string;
};

export type RepoRefsResult = {
  repo: string;
  heads: Record<string, string>;
  tags: Record<string, string>;
};

export type RepoTreeEntry = {
  name: string;
  path: string;
  mode: string;
  hash: string;
  type: "tree" | "blob" | "symlink";
};

export type RepoReadArgs = {
  repo: string;
  ref?: string;
  path?: string;
};

export type RepoReadResult =
  | {
      repo: string;
      ref: string;
      path: string;
      kind: "tree";
      entries: RepoTreeEntry[];
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

export type RepoSearchArgs = {
  repo: string;
  ref?: string;
  query: string;
  prefix?: string;
};

export type RepoSearchResult = {
  repo: string;
  ref: string;
  query: string;
  prefix?: string;
  truncated?: boolean;
  matches: Array<{
    path: string;
    line: number;
    content: string;
  }>;
};

export type RepoLogArgs = {
  repo: string;
  ref?: string;
  limit?: number;
  offset?: number;
};

export type RepoLogEntry = {
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

export type RepoLogResult = {
  repo: string;
  ref: string;
  limit: number;
  offset: number;
  entries: RepoLogEntry[];
};

export type RepoDiffLine = {
  tag: "context" | "add" | "delete" | "binary";
  content: string;
};

export type RepoDiffHunk = {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: RepoDiffLine[];
};

export type RepoDiffFile = {
  path: string;
  status: "added" | "deleted" | "modified";
  oldHash?: string;
  newHash?: string;
  hunks?: RepoDiffHunk[];
};

export type RepoDiffStats = {
  filesChanged: number;
  additions: number;
  deletions: number;
};

export type RepoDiffArgs = {
  repo: string;
  commit: string;
  context?: number;
};

export type RepoDiffResult = {
  repo: string;
  commitHash: string;
  parentHash?: string | null;
  stats: RepoDiffStats;
  files: RepoDiffFile[];
};

export type RepoCompareArgs = {
  repo: string;
  base: string;
  head: string;
  context?: number;
  stat?: boolean;
};

export type RepoCompareResult = {
  repo: string;
  base: string;
  head: string;
  stats: RepoDiffStats;
  files: RepoDiffFile[];
};

export type RepoApplyOp =
  | {
      type: "put";
      path: string;
      content?: string;
      contentBase64?: string;
    }
  | {
      type: "delete";
      path: string;
      recursive?: boolean;
    }
  | {
      type: "move";
      from: string;
      to: string;
    };

export type RepoApplyArgs = {
  repo: string;
  ref?: string;
  message: string;
  expectedHead?: string;
  allowEmpty?: boolean;
  ops: RepoApplyOp[];
};

export type RepoApplyResult = {
  ok: true;
  repo: string;
  ref: string;
  head: string | null;
};

export type RepoImportArgs = {
  repo: string;
  ref?: string;
  remoteUrl: string;
  remoteRef?: string;
  message?: string;
};

export type RepoImportResult = {
  repo: string;
  ref: string;
  head: string | null;
  changed: boolean;
  remoteUrl: string;
  remoteRef: string;
};
