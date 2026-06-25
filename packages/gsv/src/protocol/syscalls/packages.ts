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

export type PkgProfileSummary = {
  name: string;
  displayName: string;
  description?: string;
  icon?: string;
  capabilities?: string[];
};

export type PkgSummary = {
  packageId: string;
  scope: {
    kind: "global" | "user";
    uid?: number;
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
  profiles: PkgProfileSummary[];
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

export type PkgCreateTemplate = "web-ui" | "command";

export type PkgCreateArgs = {
  repo: string;
  ref?: string;
  subdir?: string;
  name?: string;
  displayName?: string;
  description?: string;
  template?: PkgCreateTemplate;
  command?: string;
  enable?: boolean;
  overwrite?: boolean;
};

export type PkgCreateResult = {
  changed: boolean;
  created: boolean;
  repo: string;
  ref: string;
  subdir: string;
  head: string | null;
  files: string[];
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
  profiles: PkgProfileSummary[];
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
