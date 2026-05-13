export type SourceRepoKind = "home" | "workspace" | "package" | "user";

export type SourceLinkedPackage = {
  packageId: string;
  name: string;
  subdir: string;
  enabled: boolean;
  reviewPending: boolean;
};

export type SourceRepoRecord = {
  repo: string;
  owner: string;
  name: string;
  kind: SourceRepoKind;
  writable: boolean;
  public: boolean;
  description?: string;
  updatedAt?: number;
  linkedPackages: SourceLinkedPackage[];
};

export type SourceRefs = {
  repo: string;
  activeRef: string;
  heads: Record<string, string>;
  tags: Record<string, string>;
};

export type SourceTreeEntry = {
  name: string;
  path: string;
  mode: string;
  hash: string;
  type: "tree" | "blob" | "symlink";
};

export type SourceReadResult =
  | {
      repo: string;
      ref: string;
      path: string;
      kind: "tree";
      entries: SourceTreeEntry[];
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

export type SourceCommit = {
  hash: string;
  treeHash: string;
  author: string;
  commitTime: number;
  message: string;
  parents: string[];
};

export type SourceCommitsPage = {
  repo: string;
  ref: string;
  limit: number;
  offset: number;
  commits: SourceCommit[];
  hasNextPage: boolean;
};

export type SourceSearchMatch = {
  path: string;
  line: number;
  content: string;
};

export type SourceSearchResult = {
  repo: string;
  ref: string;
  query: string;
  prefix?: string;
  truncated?: boolean;
  matches: SourceSearchMatch[];
};

export type SourceDiffLine = {
  tag: "context" | "add" | "delete" | "binary";
  content: string;
};

export type SourceDiffHunk = {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: SourceDiffLine[];
};

export type SourceDiffFile = {
  path: string;
  status: "added" | "deleted" | "modified";
  oldHash?: string;
  newHash?: string;
  hunks?: SourceDiffHunk[];
};

export type SourceDiffResult = {
  repo: string;
  commitHash: string;
  parentHash?: string | null;
  stats: {
    filesChanged: number;
    additions: number;
    deletions: number;
  };
  files: SourceDiffFile[];
};

export type SourcesState = {
  repos: SourceRepoRecord[];
  selectedRepo: SourceRepoRecord | null;
  refs: SourceRefs | null;
  read: SourceReadResult | null;
  commits: SourceCommit[];
  commitsPage: SourceCommitsPage | null;
};

export type LoadSourcesStateArgs = {
  repo?: string;
  ref?: string;
  path?: string;
  commitLimit?: number;
  commitOffset?: number;
};

export type LoadSourceCommitsArgs = {
  repo: string;
  ref?: string;
  limit?: number;
  offset?: number;
};

export type SearchSourceRepoArgs = {
  repo: string;
  ref?: string;
  query: string;
  prefix?: string;
};

export type DiffSourceRepoArgs = {
  repo: string;
  commit: string;
  context?: number;
};

export type PullSourceRepoArgs = {
  repo: string;
  ref?: string;
};

export type SetSourceRepoPublicArgs = {
  repo: string;
  public: boolean;
};

export type CreateSourceRepoArgs = {
  repo: string;
  ref?: string;
  description?: string;
};

export type CreateSourceRepoResult = {
  repo: string;
  ref: string;
  head: string | null;
  created: boolean;
};

export type SourceMode = "code" | "history";
