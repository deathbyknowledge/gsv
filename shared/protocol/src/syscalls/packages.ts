export type PkgRuntime = "dynamic-worker" | "node" | "web-ui";

export type PkgListArgs = {
  enabled?: boolean;
  name?: string;
  runtime?: PkgRuntime;
};

export type PkgEntrypointSummary = {
  name: string;
  kind: "command" | "http" | "rpc" | "ui";
  description?: string;
  command?: string;
  route?: string;
  icon?:
    | { kind: "builtin"; id: string }
    | { kind: "svg"; svg: string };
  syscalls?: string[];
  windowDefaults?: {
    width: number;
    height: number;
    minWidth: number;
    minHeight: number;
  };
};

export type PkgSummary = {
  packageId: string;
  scope: {
    kind: "global" | "user" | "workspace";
    uid?: number;
    workspaceId?: string;
  };
  name: string;
  description: string;
  version: string;
  runtime: PkgRuntime;
  enabled: boolean;
  source: {
    repo: string;
    ref: string;
    subdir: string;
    resolvedCommit?: string | null;
    public: boolean;
  };
  entrypoints: PkgEntrypointSummary[];
  bindingNames: string[];
  review: {
    required: boolean;
    approvedAt: number | null;
  };
  installedAt: number;
  updatedAt: number;
};

export type PkgListResult = {
  packages: PkgSummary[];
};

export type PkgInstallArgs = {
  packageId: string;
};

export type PkgInstallResult = {
  changed: boolean;
  package: PkgSummary;
};

export type PkgReviewApproveArgs = {
  packageId: string;
};

export type PkgReviewApproveResult = {
  changed: boolean;
  package: PkgSummary;
};

export type PkgAddArgs = {
  remoteUrl?: string;
  repo?: string;
  ref?: string;
  subdir?: string;
  enable?: boolean;
};

export type PkgAddResult = {
  changed: boolean;
  imported: {
    repo: string;
    remoteUrl: string;
    ref: string;
    head: string | null;
  };
  package: PkgSummary;
};

export type PkgSyncArgs = Record<string, never>;

export type PkgSyncResult = {
  packages: PkgSummary[];
};

export type PkgCheckoutArgs = {
  packageId: string;
  ref: string;
};

export type PkgCheckoutResult = {
  changed: boolean;
  package: PkgSummary;
};

export type PkgRemoveArgs = {
  packageId: string;
};

export type PkgRemoveResult = {
  changed: boolean;
  package: PkgSummary;
};

export type PkgRepoRefsArgs = {
  packageId: string;
};

export type PkgRepoRefsResult = {
  packageId: string;
  repo: string;
  activeRef: string;
  heads: Record<string, string>;
  tags: Record<string, string>;
};

export type PkgRepoTreeEntry = {
  name: string;
  path: string;
  mode: string;
  hash: string;
  type: "tree" | "blob" | "symlink";
};

export type PkgRepoReadArgs = {
  packageId: string;
  ref?: string;
  path?: string;
  root?: "package" | "repo";
};

export type PkgRepoReadResult =
  | {
      packageId: string;
      repo: string;
      ref: string;
      path: string;
      kind: "tree";
      entries: PkgRepoTreeEntry[];
    }
  | {
      packageId: string;
      repo: string;
      ref: string;
      path: string;
      kind: "file";
      size: number;
      isBinary: boolean;
      content: string | null;
    };

export type PkgRepoLogArgs = {
  packageId: string;
  ref?: string;
  limit?: number;
  offset?: number;
};

export type PkgRepoLogEntry = {
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

export type PkgRepoLogResult = {
  packageId: string;
  repo: string;
  ref: string;
  limit: number;
  offset: number;
  entries: PkgRepoLogEntry[];
};

export type PkgRepoSearchArgs = {
  packageId: string;
  ref?: string;
  query: string;
  prefix?: string;
  root?: "package" | "repo";
};

export type PkgRepoSearchMatch = {
  path: string;
  line: number;
  content: string;
};

export type PkgRepoSearchResult = {
  packageId: string;
  repo: string;
  ref: string;
  query: string;
  prefix?: string;
  root: "package" | "repo";
  truncated?: boolean;
  matches: PkgRepoSearchMatch[];
};

export type PkgRepoDiffArgs = {
  packageId: string;
  commit: string;
  context?: number;
};

export type PkgRepoDiffLine = {
  tag: "context" | "add" | "delete" | "binary";
  content: string;
};

export type PkgRepoDiffHunk = {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: PkgRepoDiffLine[];
};

export type PkgRepoDiffFile = {
  path: string;
  status: "added" | "deleted" | "modified";
  oldHash?: string;
  newHash?: string;
  hunks?: PkgRepoDiffHunk[];
};

export type PkgRepoDiffResult = {
  packageId: string;
  repo: string;
  ref: string;
  commitHash: string;
  parentHash?: string | null;
  stats: {
    filesChanged: number;
    additions: number;
    deletions: number;
  };
  files: PkgRepoDiffFile[];
};

export type PkgRemoteEntry = {
  name: string;
  baseUrl: string;
};

export type PkgRemoteListArgs = Record<string, never>;

export type PkgRemoteListResult = {
  remotes: PkgRemoteEntry[];
};

export type PkgRemoteAddArgs = {
  name: string;
  baseUrl: string;
};

export type PkgRemoteAddResult = {
  changed: boolean;
  remote: PkgRemoteEntry;
  remotes: PkgRemoteEntry[];
};

export type PkgRemoteRemoveArgs = {
  name: string;
};

export type PkgRemoteRemoveResult = {
  removed: boolean;
  remotes: PkgRemoteEntry[];
};

export type PkgCatalogEntry = {
  name: string;
  description: string;
  version: string;
  runtime: PkgRuntime;
  source: {
    repo: string;
    ref: string;
    subdir: string;
    resolvedCommit?: string | null;
  };
  entrypoints: PkgEntrypointSummary[];
  bindingNames: string[];
};

export type PkgPublicListArgs = {
  remote?: string;
};

export type PkgPublicListResult = {
  serverName: string;
  source: {
    kind: "local" | "remote";
    name: string;
    baseUrl?: string;
  };
  packages: PkgCatalogEntry[];
};

export type PkgPublicSetArgs = {
  packageId?: string;
  repo?: string;
  public: boolean;
};

export type PkgPublicSetResult = {
  changed: boolean;
  repo: string;
  public: boolean;
};
