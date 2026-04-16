export type PackagesView = "installed" | "updates" | "review" | "sources";
export type PackageScopeFilter = "all" | "mine" | "system";
export type PackageDetailTab = "overview" | "permissions" | "review" | "versions";

export type PackageEntrypoint = {
  name: string;
  kind: string;
  description?: string;
  route?: string;
  syscalls?: string[];
};

export type PackageRecord = {
  packageId: string;
  scope: {
    kind: "global" | "user" | "workspace";
    uid?: number;
    workspaceId?: string;
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
  bindingNames: string[];
};

export type CatalogRecord = {
  name: string;
  kind: "local" | "remote";
  baseUrl?: string;
  packages: CatalogEntry[];
  error?: string;
};

export type PackageDetail = {
  refs: {
    activeRef: string;
    heads: Record<string, string>;
    tags: Record<string, string>;
  };
  commits: Array<{
    hash: string;
    message: string;
    author: string;
    commitTime: number;
  }>;
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
  packageDetail: PackageDetail | null;
};

export type PackagesBackend = {
  loadState(args: { packageId?: string }): Promise<PackagesState>;
  syncSources(): Promise<{ ok: boolean }>;
  importPackage(args: { source: string; ref?: string; subdir?: string }): Promise<{ package: PackageRecord }>;
  addRemote(args: { name: string; baseUrl: string }): Promise<unknown>;
  removeRemote(args: { name: string }): Promise<unknown>;
  enablePackage(args: { packageId: string }): Promise<unknown>;
  disablePackage(args: { packageId: string }): Promise<unknown>;
  approveReview(args: { packageId: string }): Promise<unknown>;
  refreshPackage(args: { packageId: string }): Promise<unknown>;
  refreshSource(args: { repo: string }): Promise<unknown>;
  checkoutPackage(args: { packageId: string; ref: string }): Promise<unknown>;
  setPublic(args: { packageId?: string; repo?: string; public: boolean }): Promise<unknown>;
  startReview(args: { packageId: string }): Promise<{ pid: string; workspaceId: string | null; cwd: string | null }>;
};
