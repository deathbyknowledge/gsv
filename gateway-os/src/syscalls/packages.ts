export type PkgRuntime = "dynamic-worker" | "node" | "web-ui";

export type PkgListArgs = {
  enabled?: boolean;
  name?: string;
  runtime?: PkgRuntime;
};

export type PkgEntrypointSummary = {
  name: string;
  kind: "command" | "http" | "rpc" | "task" | "ui";
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
  };
  entrypoints: PkgEntrypointSummary[];
  bindingNames: string[];
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
