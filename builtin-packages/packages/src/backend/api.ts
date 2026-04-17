import type {
  KernelClientLike,
  PackageAppRpcContext,
} from "@gsv/package/worker";
import type {
  PkgRepoDiffResult,
  PkgRepoLogResult,
  PkgRepoReadResult,
  PkgRepoSearchResult,
} from "@gsv/protocol/syscalls/packages";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

type PackageLike = Record<string, unknown> & {
  packageId: string;
  name: string;
  description: string;
  version: string;
  runtime: string;
  enabled: boolean;
  scope: { kind: string; uid?: number; workspaceId?: string };
  source: {
    repo: string;
    ref: string;
    subdir: string;
    resolvedCommit?: string | null;
    public: boolean;
  };
  entrypoints: Array<{
    name: string;
    kind: string;
    description?: string;
    route?: string;
    syscalls?: string[];
  }>;
  bindingNames: string[];
  review: {
    required: boolean;
    approvedAt: number | null;
  };
  installedAt: number;
  updatedAt: number;
};

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function parseImportSource(raw: string): { remoteUrl?: string; repo?: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Source is required.");
  }
  if (trimmed.includes("://") || trimmed.startsWith("git@")) {
    return { remoteUrl: trimmed };
  }
  return { repo: trimmed.replace(/^\/+|\/+$/g, "") };
}

function isBuiltinRepo(repo: string): boolean {
  return repo === "system/gsv";
}

function repoOwner(repo: string): string {
  return repo.split("/")[0] ?? "";
}

function normalizeViewer(viewer: { uid: number; username: string }) {
  return {
    uid: viewer.uid,
    username: viewer.username || (viewer.uid === 0 ? "root" : "user"),
    isRoot: viewer.uid === 0,
  };
}

function buildReviewPrompt(pkg: PackageLike): string {
  const bindings = pkg.bindingNames.length > 0 ? pkg.bindingNames.join(", ") : "none declared";
  const entrypoints = pkg.entrypoints.length > 0
    ? pkg.entrypoints.map((entry) => `${entry.name}:${entry.kind}`).join(", ")
    : "none";

  return [
    `Review the imported package \"${pkg.name}\".`,
    "",
    "Current directory is already /src/package.",
    "The package source is mounted read-only at /src/package.",
    "The full repository is mounted read-only at /src/repo.",
    "",
    `Source repo: ${pkg.source.repo}`,
    `Source ref: ${pkg.source.ref}`,
    `Subdir: ${pkg.source.subdir}`,
    `Declared bindings: ${bindings}`,
    `Entrypoints: ${entrypoints}`,
    "",
    "Review workflow:",
    "1. Start with pkg manifest, pkg capabilities, pkg refs, and pkg log.",
    "2. Inspect /src/package, prioritizing manifest, entrypoints, and system integration points.",
    "3. Search for network access, parent-window messaging, host bridge use, process spawning, filesystem writes, shell execution, eval, and destructive actions.",
    "4. If a command fails, note it briefly and continue with other evidence. Do not guess.",
    "5. Keep tool use tight. Do not narrate trivial navigation or run placeholder commands.",
    "",
    "Use normal filesystem and shell exploration plus the pkg CLI.",
    "Helpful commands: ls, find, grep, cat, pkg manifest, pkg capabilities, pkg refs, pkg log.",
    "Focus on requested capabilities, suspicious behavior, hidden network or shell access, destructive actions, and whether it should be enabled.",
    "Call out privileged integrations explicitly, including host bridge access, parent-window messaging, and process spawning if present.",
    "Conclude with a short verdict: approve or do not approve, followed by a concise evidence-based summary.",
  ].join("\n");
}

async function listPackages(kernel: KernelClientLike): Promise<PackageLike[]> {
  const result = asRecord(await kernel.request("pkg.list", {}));
  return asArray<PackageLike>(result?.packages);
}

async function loadRefsForPackages(
  kernel: KernelClientLike,
  packages: PackageLike[],
): Promise<Map<string, Record<string, string>>> {
  const byRepo = new Map<string, PackageLike>();
  for (const pkg of packages) {
    if (!byRepo.has(pkg.source.repo)) {
      byRepo.set(pkg.source.repo, pkg);
    }
  }

  const entries = await Promise.all([...byRepo.entries()].map(async ([repo, pkg]) => {
    try {
      const refs = asRecord(await kernel.request("pkg.repo.refs", { packageId: pkg.packageId }));
      return [repo, {
        ...asRecord(refs?.heads),
        ...asRecord(refs?.tags),
      }] as const;
    } catch {
      return [repo, {}] as const;
    }
  }));

  return new Map(entries);
}

function describeSourceHealth(pkg: PackageLike, refsByRepo: Map<string, Record<string, string>>) {
  const refs = refsByRepo.get(pkg.source.repo) ?? {};
  const refHead = typeof refs[pkg.source.ref] === "string" ? String(refs[pkg.source.ref]) : null;
  const resolvedCommit = pkg.source.resolvedCommit ?? null;
  const updateAvailable = refHead !== null && resolvedCommit !== refHead;
  return {
    currentHead: refHead,
    updateAvailable,
  };
}

function derivePackageView(
  pkg: PackageLike,
  refsByRepo: Map<string, Record<string, string>>,
  viewer: ReturnType<typeof normalizeViewer>,
) {
  const sourceHealth = describeSourceHealth(pkg, refsByRepo);
  const declaredSyscalls = unique(pkg.entrypoints.flatMap((entry) => asArray<string>(entry.syscalls)));
  const uiEntrypoints = pkg.entrypoints.filter((entry) => entry.kind === "ui" && asString(entry.route).length > 0);
  const canMutate = viewer.isRoot || (pkg.scope.kind === "user" && pkg.scope.uid === viewer.uid);
  const canChangeVisibility = viewer.isRoot || repoOwner(pkg.source.repo) === viewer.username;
  return {
    ...pkg,
    reviewPending: pkg.review.required && !pkg.review.approvedAt,
    reviewed: pkg.review.required && Boolean(pkg.review.approvedAt),
    isBuiltin: isBuiltinRepo(pkg.source.repo),
    declaredSyscalls,
    uiEntrypoints,
    currentHead: sourceHealth.currentHead,
    updateAvailable: sourceHealth.updateAvailable,
    canMutate,
    canChangeVisibility,
  };
}

function aggregateSources(packages: ReturnType<typeof derivePackageView>[]) {
  const byRepo = new Map<string, {
    repo: string;
    public: boolean;
    isBuiltin: boolean;
    packageIds: string[];
    packageNames: string[];
    packageCount: number;
    reviewPendingCount: number;
    updateCount: number;
    latestUpdatedAt: number;
    canChangeVisibility: boolean;
    hasImmutablePackages: boolean;
  }>();

  for (const pkg of packages) {
    const current = byRepo.get(pkg.source.repo) ?? {
      repo: pkg.source.repo,
      public: pkg.source.public,
      isBuiltin: pkg.isBuiltin,
      packageIds: [],
      packageNames: [],
      packageCount: 0,
      reviewPendingCount: 0,
      updateCount: 0,
      latestUpdatedAt: 0,
      canChangeVisibility: pkg.canChangeVisibility,
      hasImmutablePackages: !pkg.canMutate,
    };
    current.public = current.public || pkg.source.public;
    current.packageIds.push(pkg.packageId);
    current.packageNames.push(pkg.name);
    current.packageCount += 1;
    if (pkg.reviewPending) current.reviewPendingCount += 1;
    if (pkg.updateAvailable) current.updateCount += 1;
    current.latestUpdatedAt = Math.max(current.latestUpdatedAt, pkg.updatedAt);
    current.canChangeVisibility = current.canChangeVisibility || pkg.canChangeVisibility;
    current.hasImmutablePackages = current.hasImmutablePackages || !pkg.canMutate;
    byRepo.set(pkg.source.repo, current);
  }

  return [...byRepo.values()]
    .sort((left, right) => left.repo.localeCompare(right.repo))
    .map((source) => ({
      ...source,
      packageNames: source.packageNames.sort((left, right) => left.localeCompare(right)),
      refreshable: !source.isBuiltin && !source.hasImmutablePackages,
    }));
}

async function loadCatalogs(kernel: KernelClientLike): Promise<Array<{
  name: string;
  kind: "local" | "remote";
  baseUrl?: string;
  packages: Record<string, unknown>[];
  error?: string;
}>> {
  const remotesResult = asRecord(await kernel.request("pkg.remote.list", {}));
  const remotes = asArray<Record<string, unknown>>(remotesResult?.remotes);

  const catalogs = await Promise.all([
    (async () => {
      try {
        const result = asRecord(await kernel.request("pkg.public.list", {}));
        return {
          name: "local",
          kind: "local" as const,
          packages: asArray<Record<string, unknown>>(result?.packages),
        };
      } catch (error) {
        return {
          name: "local",
          kind: "local" as const,
          packages: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }
    })(),
    ...remotes.map(async (remote) => {
      const name = asString(remote.name);
      const baseUrl = asString(remote.baseUrl);
      try {
        const result = asRecord(await kernel.request("pkg.public.list", { remote: name }));
        return {
          name,
          kind: "remote" as const,
          baseUrl,
          packages: asArray<Record<string, unknown>>(result?.packages),
        };
      } catch (error) {
        return {
          name,
          kind: "remote" as const,
          baseUrl,
          packages: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  ]);

  return catalogs;
}

async function loadPackageDetail(kernel: KernelClientLike, packageId: string) {
  const [refs, log] = await Promise.all([
    kernel.request("pkg.repo.refs", { packageId }),
    kernel.request("pkg.repo.log", { packageId, limit: 20, offset: 0 }) as Promise<PkgRepoLogResult>,
  ]);
  const refsRecord = asRecord(refs);
  return {
    refs: {
      activeRef: asString(refsRecord?.activeRef),
      heads: asRecord(refsRecord?.heads) ?? {},
      tags: asRecord(refsRecord?.tags) ?? {},
    },
    commits: asArray<Record<string, unknown>>(log?.entries).map((entry) => ({
      hash: asString(entry.hash),
      message: asString(entry.message),
      author: asString(entry.author),
      commitTime: asNumber(entry.commitTime),
    })),
  };
}

export async function loadState(
  args: { packageId?: string } | undefined,
  kernel: KernelClientLike,
  ctx: PackageAppRpcContext,
) {
  const viewer = normalizeViewer(ctx.viewer);
  const packagesRaw = await listPackages(kernel);
  const refsByRepo = await loadRefsForPackages(kernel, packagesRaw);
  const packages = packagesRaw.map((pkg) => derivePackageView(pkg, refsByRepo, viewer));
  const sources = aggregateSources(packages);
  const catalogs = await loadCatalogs(kernel);

  let packageDetail = null;
  const packageId = typeof args?.packageId === "string" ? args.packageId.trim() : "";
  if (packageId) {
    const target = packages.find((pkg) => pkg.packageId === packageId);
    if (target) {
      try {
        packageDetail = await loadPackageDetail(kernel, packageId);
      } catch {
        packageDetail = null;
      }
    }
  }

  return {
    viewer,
    packages,
    sources,
    catalogs,
    counts: {
      installed: packages.length,
      review: packages.filter((pkg) => pkg.reviewPending).length,
      updates: packages.filter((pkg) => pkg.updateAvailable).length,
    },
    packageDetail,
  };
}

export async function syncSources(kernel: KernelClientLike) {
  const packages = await listPackages(kernel);
  await kernel.request("pkg.sync", {});
  const uniqueImports = unique(packages
    .filter((pkg) => !isBuiltinRepo(pkg.source.repo))
    .map((pkg) => `${pkg.source.repo}|${pkg.source.ref}|${pkg.source.subdir}`));

  for (const entry of uniqueImports) {
    const [repo, ref, subdir] = entry.split("|");
    await kernel.request("pkg.add", { repo, ref, subdir });
  }

  return { ok: true };
}

export async function importPackage(
  kernel: KernelClientLike,
  args: { source: string; ref?: string; subdir?: string },
) {
  const source = parseImportSource(asString(args.source));
  return kernel.request("pkg.add", {
    ...source,
    ref: asString(args.ref) || "main",
    subdir: asString(args.subdir) || ".",
  });
}

export async function addRemote(
  kernel: KernelClientLike,
  args: { name: string; baseUrl: string },
) {
  return kernel.request("pkg.remote.add", {
    name: asString(args.name),
    baseUrl: asString(args.baseUrl),
  });
}

export async function removeRemote(
  kernel: KernelClientLike,
  args: { name: string },
) {
  return kernel.request("pkg.remote.remove", { name: asString(args.name) });
}

export async function enablePackage(kernel: KernelClientLike, args: { packageId: string }) {
  return kernel.request("pkg.install", { packageId: asString(args.packageId) });
}

export async function disablePackage(kernel: KernelClientLike, args: { packageId: string }) {
  return kernel.request("pkg.remove", { packageId: asString(args.packageId) });
}

export async function approveReview(kernel: KernelClientLike, args: { packageId: string }) {
  return kernel.request("pkg.review.approve", { packageId: asString(args.packageId) });
}

export async function checkoutPackage(
  kernel: KernelClientLike,
  args: { packageId: string; ref: string },
) {
  return kernel.request("pkg.checkout", {
    packageId: asString(args.packageId),
    ref: asString(args.ref),
  });
}

export async function refreshPackage(kernel: KernelClientLike, args: { packageId: string }) {
  const packages = await listPackages(kernel);
  const target = packages.find((pkg) => pkg.packageId === asString(args.packageId));
  if (!target) {
    throw new Error(`Unknown package: ${asString(args.packageId)}`);
  }
  if (isBuiltinRepo(target.source.repo)) {
    return kernel.request("pkg.sync", {});
  }
  return kernel.request("pkg.add", {
    repo: target.source.repo,
    ref: target.source.ref,
    subdir: target.source.subdir,
  });
}

export async function refreshSource(kernel: KernelClientLike, args: { repo: string }) {
  const repo = asString(args.repo);
  if (!repo) {
    throw new Error("repo is required");
  }
  const packages = await listPackages(kernel);
  const sourcePackages = packages.filter((pkg) => pkg.source.repo === repo);
  if (sourcePackages.length === 0) {
    throw new Error(`Unknown source: ${repo}`);
  }
  if (isBuiltinRepo(repo)) {
    return kernel.request("pkg.sync", {});
  }
  const uniqueTargets = unique(sourcePackages.map((pkg) => `${pkg.source.ref}|${pkg.source.subdir}`));
  for (const entry of uniqueTargets) {
    const [ref, subdir] = entry.split("|");
    await kernel.request("pkg.add", { repo, ref, subdir });
  }
  return { ok: true };
}

export async function setPublic(
  kernel: KernelClientLike,
  args: { packageId?: string; repo?: string; public: boolean },
) {
  return kernel.request("pkg.public.set", {
    packageId: asString(args.packageId) || undefined,
    repo: asString(args.repo) || undefined,
    public: args.public === true,
  });
}

export async function startReview(kernel: KernelClientLike, args: { packageId: string }) {
  const packages = await listPackages(kernel);
  const target = packages.find((pkg) => pkg.packageId === asString(args.packageId));
  if (!target) {
    throw new Error(`Unknown package: ${asString(args.packageId)}`);
  }

  const spawned = asRecord(await kernel.request("proc.spawn", {
    profile: "review",
    label: `Review ${target.name}`,
    prompt: buildReviewPrompt(target),
    workspace: { mode: "none" },
    mounts: [
      { kind: "package-source", packageId: target.packageId, mountPath: "/src/package" },
      { kind: "package-repo", packageId: target.packageId, mountPath: "/src/repo" },
    ],
  }));

  if (!asBoolean(spawned?.ok)) {
    throw new Error(asString(spawned?.error) || "Failed to spawn review process");
  }

  return {
    pid: asString(spawned?.pid),
    workspaceId: asString(spawned?.workspaceId) || null,
    cwd: asString(spawned?.cwd) || null,
  };
}

export async function readRepo(
  kernel: KernelClientLike,
  args: { packageId: string; ref?: string; path?: string; root?: "package" | "repo" },
): Promise<PkgRepoReadResult> {
  return kernel.request("pkg.repo.read", {
    packageId: asString(args.packageId),
    ref: asString(args.ref) || undefined,
    path: asString(args.path) || undefined,
    root: args.root === "repo" ? "repo" : "package",
  }) as Promise<PkgRepoReadResult>;
}

export async function searchRepo(
  kernel: KernelClientLike,
  args: { packageId: string; ref?: string; query: string; prefix?: string; root?: "package" | "repo" },
): Promise<PkgRepoSearchResult> {
  return kernel.request("pkg.repo.search", {
    packageId: asString(args.packageId),
    ref: asString(args.ref) || undefined,
    query: asString(args.query),
    prefix: asString(args.prefix) || undefined,
    root: args.root === "repo" ? "repo" : "package",
  }) as Promise<PkgRepoSearchResult>;
}

export async function diffRepo(
  kernel: KernelClientLike,
  args: { packageId: string; commit: string; context?: number },
): Promise<PkgRepoDiffResult> {
  return kernel.request("pkg.repo.diff", {
    packageId: asString(args.packageId),
    commit: asString(args.commit),
    context: typeof args.context === "number" ? args.context : 3,
  }) as Promise<PkgRepoDiffResult>;
}
