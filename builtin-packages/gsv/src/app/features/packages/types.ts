export type PackagesView = "inventory" | "updates" | "review" | "discover" | "create" | "remotes";
export type PackageScopeFilter = "all" | "mine" | "system";
export type PackageCreateTemplate = "web-ui" | "command";

export type PackageEntrypoint = {
  name: string;
  kind: "command" | "http" | "rpc" | "ui";
  description?: string;
  command?: string;
  route?: string;
  syscalls?: string[];
};

export type PackageProfile = {
  name: string;
  displayName: string;
  description?: string;
  icon?: string;
};

export type PackageRecord = {
  packageId: string;
  scope: {
    kind: "global" | "user";
    uid?: number;
  };
  name: string;
  description: string;
  version: string;
  runtime: string;
  enabled: boolean;
  source: {
    repo: string;
    ref: string;
    subdir: string;
    resolvedCommit?: string | null;
    public: boolean;
  };
  entrypoints: PackageEntrypoint[];
  profiles: PackageProfile[];
  bindingNames: string[];
  review: {
    required: boolean;
    approvedAt: number | null;
  };
  installedAt: number;
  updatedAt: number;
  reviewPending: boolean;
  reviewed: boolean;
  isBuiltin: boolean;
  declaredSyscalls: string[];
  uiEntrypoints: PackageEntrypoint[];
  currentHead: string | null;
  updateAvailable: boolean;
  canMutate: boolean;
  canChangeVisibility: boolean;
  canPullSource: boolean;
};

export type SourceRecord = {
  repo: string;
  public: boolean;
  isBuiltin: boolean;
  packageIds: string[];
  packageNames: string[];
  packageCount: number;
  reviewPendingCount: number;
  updateCount: number;
  latestUpdatedAt: number;
  refreshable: boolean;
  pullable: boolean;
  canChangeVisibility: boolean;
};

export type CatalogEntry = {
  name: string;
  description?: string;
  version?: string;
  runtime?: string;
  source: {
    repo: string;
    ref: string;
    subdir: string;
    resolvedCommit?: string | null;
  };
  entrypoints: PackageEntrypoint[];
  profiles: PackageProfile[];
  bindingNames: string[];
};

export type CatalogRecord = {
  name: string;
  kind: "local" | "remote";
  baseUrl?: string;
  packages: CatalogEntry[];
  error?: string;
};

export type PackagesState = {
  viewer: {
    uid: number;
    username: string;
    isRoot: boolean;
  };
  packages: PackageRecord[];
  sources: SourceRecord[];
  catalogs: CatalogRecord[];
  counts: {
    installed: number;
    review: number;
    updates: number;
  };
};

export type LoadPackagesStateArgs = {
  packageId?: string;
};

export type PackageIdArgs = {
  packageId: string;
};

export type PullPackageSourceArgs = {
  repo: string;
};

export type SetPackagePublicArgs = {
  packageId?: string;
  repo?: string;
  public: boolean;
};

export type StartPackageReviewResult = {
  pid: string;
  cwd: string | null;
};

export type ImportPackageArgs = {
  source: string;
  ref?: string;
  subdir?: string;
};

export type ImportPackageResult = {
  package: PackageRecord;
};

export type CreatePackageArgs = {
  repo: string;
  ref?: string;
  subdir?: string;
  name?: string;
  displayName?: string;
  description?: string;
  template?: PackageCreateTemplate;
  command?: string;
  enable?: boolean;
  overwrite?: boolean;
};

export type CreatePackageResult = {
  package: PackageRecord;
  created: boolean;
  files: string[];
};

export type AddCatalogRemoteArgs = {
  name: string;
  baseUrl: string;
};

export type RemoveCatalogRemoteArgs = {
  name: string;
};
