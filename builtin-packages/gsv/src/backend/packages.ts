import type {
  CatalogEntry,
  CatalogRecord,
  AddCatalogRemoteArgs,
  CreatePackageArgs,
  CreatePackageResult,
  ImportPackageArgs,
  ImportPackageResult,
  LoadPackagesStateArgs,
  PackageEntrypoint,
  PackageProfile,
  PackageRecord,
  PullPackageSourceArgs,
  PackagesState,
  PackageIdArgs,
  RemoveCatalogRemoteArgs,
  SetPackagePublicArgs,
  SourceRecord,
  StartPackageReviewResult,
} from "../app/features/packages/types";

type KernelClientLike = {
  request(method: string, payload?: unknown): Promise<unknown>;
};

type ViewerRuntime = {
  viewer?: {
    uid?: number;
    username?: string;
  };
};

type NormalizedViewer = PackagesState["viewer"];

type PackageLike = {
  packageId: string;
  scope: PackageRecord["scope"];
  name: string;
  description: string;
  version: string;
  runtime: string;
  enabled: boolean;
  source: PackageRecord["source"];
  entrypoints: PackageEntrypoint[];
  profiles?: PackageProfile[];
  bindingNames: string[];
  review: PackageRecord["review"];
  installedAt: number;
  updatedAt: number;
};

type RemoteRecord = {
  name?: unknown;
  baseUrl?: unknown;
};

type DerivedPackageRecord = PackageRecord;

type SourceUpdateComparison = {
  repo: string;
  base: string;
  head: string;
};

export async function loadPackagesState(
  _args: LoadPackagesStateArgs | undefined,
  kernel: KernelClientLike,
  ctx: ViewerRuntime,
): Promise<PackagesState> {
  const viewer = normalizeViewer({
    uid: ctx.viewer?.uid ?? 0,
    username: ctx.viewer?.username ?? "",
  });
  const packagesRaw = await listPackages(kernel);
  const refsByRepo = await loadRefsForPackages(kernel, packagesRaw);
  const changedPathsByComparison = await loadChangedPathsForPackageUpdates(kernel, packagesRaw, refsByRepo);
  const packages = packagesRaw.map((pkg) => derivePackageView(pkg, refsByRepo, changedPathsByComparison, viewer));
  const sources = aggregateSources(packages);
  const catalogs = await loadCatalogs(kernel);

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
  };
}

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

function asStringRecord(value: unknown): Record<string, string> {
  const record = asRecord(value) ?? {};
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === "string") {
      result[key] = item;
    }
  }
  return result;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function comparisonKey(repo: string, base: string, head: string): string {
  return `${repo}\0${base}\0${head}`;
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
  return repo === "root/gsv";
}

function repoOwner(repo: string): string {
  return repo.split("/")[0] ?? "";
}

function normalizeViewer(viewer: { uid: number; username: string }): NormalizedViewer {
  return {
    uid: viewer.uid,
    username: viewer.username || (viewer.uid === 0 ? "root" : "user"),
    isRoot: viewer.uid === 0,
  };
}

function canMutatePackage(pkg: PackageLike, viewer: NormalizedViewer): boolean {
  return viewer.isRoot || (pkg.scope.kind === "user" && pkg.scope.uid === viewer.uid);
}

function packageSourcePathName(pkg: PackageLike): string {
  return pkg.name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function packageSourcePathNameForPackage(pkg: PackageLike, packages: PackageLike[]): string {
  const names = packageSourcePathNameMap(packages);
  const targetKey = packageSourceRecordKey(pkg);
  for (const [record, name] of names) {
    if (packageSourceRecordKey(record) === targetKey) {
      return name;
    }
  }
  return packageSourcePathName(pkg);
}

function packageSourcePathNameMap(packages: PackageLike[]): Map<PackageLike, string> {
  const entries = packages.map((pkg) => ({
    pkg,
    baseName: packageSourcePathName(pkg) || sanitizeSourcePathSegment(pkg.packageId) || "package",
  }));
  const counts = new Map<string, number>();
  for (const entry of entries) {
    counts.set(entry.baseName, (counts.get(entry.baseName) ?? 0) + 1);
  }

  const used = new Set<string>();
  const result = new Map<PackageLike, string>();
  for (const entry of entries.sort(compareSourcePathEntries)) {
    const collides = (counts.get(entry.baseName) ?? 0) > 1;
    const preferred = collides
      ? `${entry.baseName}--${packageSourcePathDisambiguator(entry.pkg)}`
      : entry.baseName;
    const name = uniqueSourcePathName(preferred, used);
    used.add(name);
    result.set(entry.pkg, name);
  }
  return result;
}

function compareSourcePathEntries(
  left: { pkg: PackageLike; baseName: string },
  right: { pkg: PackageLike; baseName: string },
): number {
  const name = left.baseName.localeCompare(right.baseName);
  if (name !== 0) {
    return name;
  }
  const source = sourcePathDisambiguationKey(left.pkg).localeCompare(sourcePathDisambiguationKey(right.pkg));
  if (source !== 0) {
    return source;
  }
  return packageSourceRecordKey(left.pkg).localeCompare(packageSourceRecordKey(right.pkg));
}

function packageSourcePathDisambiguator(pkg: PackageLike): string {
  return sanitizeSourcePathSegment(sourcePathDisambiguationKey(pkg))
    || sanitizeSourcePathSegment(pkg.packageId)
    || "package";
}

function sourcePathDisambiguationKey(pkg: PackageLike): string {
  const subdir = pkg.source.subdir.trim().replace(/^\/+|\/+$/g, "");
  return subdir && subdir !== "."
    ? `${pkg.source.repo}-${subdir}`
    : pkg.source.repo;
}

function sanitizeSourcePathSegment(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function uniqueSourcePathName(preferred: string, used: Set<string>): string {
  let candidate = preferred || "package";
  let index = 2;
  while (used.has(candidate)) {
    candidate = `${preferred || "package"}-${index}`;
    index += 1;
  }
  return candidate;
}

function packageSourceRecordKey(pkg: PackageLike): string {
  switch (pkg.scope.kind) {
    case "user":
      return `user:${pkg.scope.uid ?? ""}:${pkg.packageId}`;
    case "global":
      return `global:${pkg.packageId}`;
    default:
      return `${pkg.scope.kind}:${pkg.packageId}`;
  }
}

function buildReviewPrompt(pkg: PackageLike, packages: PackageLike[]): string {
  const bindings = pkg.bindingNames.length > 0 ? pkg.bindingNames.join(", ") : "none declared";
  const entrypoints = pkg.entrypoints.length > 0
    ? pkg.entrypoints.map((entry) => `${entry.name}:${entry.kind}`).join(", ")
    : "none";
  const sourcePath = `/src/packages/${packageSourcePathNameForPackage(pkg, packages)}`;

  return [
    `Review the imported package "${pkg.name}".`,
    "",
    `Current directory is already ${sourcePath}.`,
    `The package source is available at ${sourcePath}.`,
    "Source writes are staged in the review process. Use pkg source status/diff to inspect staged changes; do not commit unless explicitly asked.",
    "",
    `Source repo: ${pkg.source.repo}`,
    `Source ref: ${pkg.source.ref}`,
    `Subdir: ${pkg.source.subdir}`,
    `Declared bindings: ${bindings}`,
    `Entrypoints: ${entrypoints}`,
    "",
    "Review workflow:",
    "1. Start with pkg manifest, pkg capabilities, pkg refs, and pkg log.",
    `2. Inspect ${sourcePath}, prioritizing manifest, entrypoints, and system integration points.`,
    "3. Search for network access, parent-window messaging, host bridge use, process spawning, filesystem writes, shell execution, eval, and destructive actions.",
    "4. If a command fails, note it briefly and continue with other evidence. Do not guess.",
    "5. Keep tool use tight. Do not narrate trivial navigation or run placeholder commands.",
    "",
    "Use normal filesystem and shell exploration plus the pkg CLI.",
    "Helpful commands: ls, find, grep, cat, pkg manifest, pkg capabilities, pkg refs, pkg log, pkg source status, pkg source diff.",
    "Focus on requested capabilities, suspicious behavior, hidden network or shell access, destructive actions, and whether it should be enabled.",
    "Call out privileged integrations explicitly, including host bridge access, parent-window messaging, and process spawning if present.",
    "Conclude with a short verdict: approve or do not approve, followed by a concise evidence-based summary.",
  ].join("\n");
}

function buildReviewAssignmentContext(pkg: PackageLike, packages: PackageLike[]): string {
  const sourcePath = `/src/packages/${packageSourcePathNameForPackage(pkg, packages)}`;
  return [
    "# Package Review",
    "",
    `You are reviewing the imported package "${pkg.name}".`,
    `The package source is mounted at ${sourcePath}, and the process starts there.`,
    "",
    "Treat this as a focused code review for whether the package should be enabled.",
    "Prioritize manifest, entrypoints, declared capabilities, host bridge usage, filesystem writes, shell execution, process spawning, network access, eval, and destructive actions.",
    "Keep evidence concrete. If a command fails, note it briefly and continue with other review evidence.",
    "Do not approve the package unless the reviewed source and requested capabilities match the user's intent.",
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

  const entries = await Promise.all([...byRepo.keys()].map(async (repo) => {
    try {
      const refs = asRecord(await kernel.request("repo.refs", { repo }));
      return [repo, {
        ...asStringRecord(refs?.heads),
        ...asStringRecord(refs?.tags),
      }] as const;
    } catch {
      return [repo, {}] as const;
    }
  }));

  return new Map(entries);
}

async function loadChangedPathsForPackageUpdates(
  kernel: KernelClientLike,
  packages: PackageLike[],
  refsByRepo: Map<string, Record<string, string>>,
): Promise<Map<string, string[] | null>> {
  const comparisons = new Map<string, SourceUpdateComparison>();
  for (const pkg of packages) {
    const head = sourceRefHead(pkg, refsByRepo);
    const base = pkg.source.resolvedCommit ?? null;
    if (!base || !head || base === head) {
      continue;
    }
    comparisons.set(comparisonKey(pkg.source.repo, base, head), {
      repo: pkg.source.repo,
      base,
      head,
    });
  }

  const entries = await Promise.all([...comparisons.values()].map(async (comparison) => {
    const key = comparisonKey(comparison.repo, comparison.base, comparison.head);
    try {
      const result = asRecord(await kernel.request("repo.compare", {
        repo: comparison.repo,
        base: comparison.base,
        head: comparison.head,
        context: 0,
        stat: true,
      }));
      const paths = asArray<Record<string, unknown>>(result?.files)
        .map((file) => normalizeRepoPath(asString(file.path)))
        .filter((path) => path.length > 0);
      return [key, paths] as const;
    } catch {
      return [key, null] as const;
    }
  }));

  return new Map(entries);
}

function sourceRefHead(
  pkg: PackageLike,
  refsByRepo: Map<string, Record<string, string>>,
): string | null {
  const refs = refsByRepo.get(pkg.source.repo) ?? {};
  return typeof refs[pkg.source.ref] === "string" ? refs[pkg.source.ref] : null;
}

function describeSourceHealth(
  pkg: PackageLike,
  refsByRepo: Map<string, Record<string, string>>,
  changedPathsByComparison: Map<string, string[] | null>,
): Pick<PackageRecord, "currentHead" | "updateAvailable"> {
  const refHead = sourceRefHead(pkg, refsByRepo);
  const resolvedCommit = pkg.source.resolvedCommit ?? null;
  const updateAvailable = packageUpdateAvailable(pkg, resolvedCommit, refHead, changedPathsByComparison);
  return {
    currentHead: refHead,
    updateAvailable,
  };
}

function packageUpdateAvailable(
  pkg: PackageLike,
  resolvedCommit: string | null,
  refHead: string | null,
  changedPathsByComparison: Map<string, string[] | null>,
): boolean {
  if (!refHead || resolvedCommit === refHead) {
    return false;
  }
  if (!resolvedCommit) {
    return true;
  }

  const key = comparisonKey(pkg.source.repo, resolvedCommit, refHead);
  if (!changedPathsByComparison.has(key)) {
    return true;
  }
  const changedPaths = changedPathsByComparison.get(key);
  if (!changedPaths) {
    return true;
  }
  return changedPaths.some((path) => pathIsInPackageSubdir(path, pkg.source.subdir));
}

function pathIsInPackageSubdir(path: string, subdir: string): boolean {
  const normalizedPath = normalizeRepoPath(path);
  const normalizedSubdir = normalizePackageSubdir(subdir);
  if (!normalizedSubdir) {
    return normalizedPath.length > 0;
  }
  return normalizedPath === normalizedSubdir || normalizedPath.startsWith(`${normalizedSubdir}/`);
}

function normalizeRepoPath(path: string): string {
  return path.trim().replace(/^\/+|\/+$/g, "").replace(/\/+/g, "/");
}

function normalizePackageSubdir(path: string): string {
  const normalized = normalizeRepoPath(path);
  return normalized === "." ? "" : normalized;
}

function derivePackageView(
  pkg: PackageLike,
  refsByRepo: Map<string, Record<string, string>>,
  changedPathsByComparison: Map<string, string[] | null>,
  viewer: NormalizedViewer,
): DerivedPackageRecord {
  const sourceHealth = describeSourceHealth(pkg, refsByRepo, changedPathsByComparison);
  const entrypoints = asArray<PackageEntrypoint>(pkg.entrypoints);
  const uiEntrypoints = entrypoints.filter((entry) => entry.kind === "ui" && asString(entry.route).length > 0);
  const profiles = asArray<Record<string, unknown>>(pkg.profiles).map((profile) => ({
    name: asString(profile.name),
    displayName: asString(profile.displayName),
    description: asString(profile.description) || undefined,
    icon: asString(profile.icon) || undefined,
    capabilities: asArray<string>(profile.capabilities),
  }));
  const declaredSyscalls = unique([
    ...entrypoints.flatMap((entry) => asArray<string>(entry.syscalls)),
    ...profiles.flatMap((profile) => profile.capabilities ?? []),
  ]);
  const canMutate = canMutatePackage(pkg, viewer);
  const canChangeVisibility = viewer.isRoot || repoOwner(pkg.source.repo) === viewer.username;
  const canPullSource = canChangeVisibility && (isBuiltinRepo(pkg.source.repo) || pkg.review.required);

  return {
    ...pkg,
    entrypoints,
    profiles,
    reviewPending: pkg.review.required && !pkg.review.approvedAt,
    reviewed: pkg.review.required && Boolean(pkg.review.approvedAt),
    isBuiltin: isBuiltinRepo(pkg.source.repo),
    declaredSyscalls,
    uiEntrypoints,
    currentHead: sourceHealth.currentHead,
    updateAvailable: sourceHealth.updateAvailable,
    canMutate,
    canChangeVisibility,
    canPullSource,
  };
}

function aggregateSources(packages: DerivedPackageRecord[]): SourceRecord[] {
  const byRepo = new Map<string, SourceRecord & {
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
      refreshable: false,
      pullable: pkg.canPullSource,
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
    current.pullable = current.pullable || pkg.canPullSource;
    byRepo.set(pkg.source.repo, current);
  }

  return [...byRepo.values()]
    .sort((left, right) => left.repo.localeCompare(right.repo))
    .map((source) => ({
      repo: source.repo,
      public: source.public,
      isBuiltin: source.isBuiltin,
      packageIds: source.packageIds,
      packageNames: source.packageNames.sort((left, right) => left.localeCompare(right)),
      packageCount: source.packageCount,
      reviewPendingCount: source.reviewPendingCount,
      updateCount: source.updateCount,
      latestUpdatedAt: source.latestUpdatedAt,
      refreshable: !source.hasImmutablePackages,
      pullable: source.pullable,
      canChangeVisibility: source.canChangeVisibility,
    }));
}

async function loadCatalogs(kernel: KernelClientLike): Promise<CatalogRecord[]> {
  const remotesResult = asRecord(await kernel.request("pkg.remote.list", {}));
  const remotes = asArray<RemoteRecord>(remotesResult?.remotes);

  return Promise.all([
    (async () => {
      try {
        const result = asRecord(await kernel.request("pkg.public.list", {}));
        return {
          name: "local",
          kind: "local" as const,
          packages: normalizeCatalogEntries(result?.packages),
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
          packages: normalizeCatalogEntries(result?.packages),
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
}

function normalizeCatalogEntries(value: unknown): CatalogEntry[] {
  return asArray<Record<string, unknown>>(value).map((entry) => {
    const source = asRecord(entry.source) ?? {};
    return {
      name: asString(entry.name),
      description: asString(entry.description) || undefined,
      version: asString(entry.version) || undefined,
      runtime: asString(entry.runtime) || undefined,
      source: {
        repo: asString(source.repo),
        ref: asString(source.ref),
        subdir: asString(source.subdir),
        resolvedCommit: typeof source.resolvedCommit === "string" ? source.resolvedCommit : null,
      },
      entrypoints: asArray<PackageEntrypoint>(entry.entrypoints),
      profiles: asArray<Record<string, unknown>>(entry.profiles).map((profile) => ({
        name: asString(profile.name),
        displayName: asString(profile.displayName),
        description: asString(profile.description) || undefined,
        icon: asString(profile.icon) || undefined,
        capabilities: asArray<string>(profile.capabilities),
      })),
      bindingNames: asArray<string>(entry.bindingNames),
    };
  });
}

export async function syncPackages(kernel: KernelClientLike, ctx: ViewerRuntime): Promise<{ ok: boolean }> {
  const viewer = normalizeViewer({
    uid: ctx.viewer?.uid ?? 0,
    username: ctx.viewer?.username ?? "",
  });
  await kernel.request("pkg.sync", {});
  const packages = await listPackages(kernel);
  for (const pkg of packages) {
    if (isBuiltinRepo(pkg.source.repo) || !canMutatePackage(pkg, viewer)) {
      continue;
    }
    await kernel.request("pkg.checkout", {
      packageId: pkg.packageId,
      ref: pkg.source.ref,
    });
  }
  return { ok: true };
}

export async function importPackage(
  kernel: KernelClientLike,
  args: ImportPackageArgs,
): Promise<ImportPackageResult> {
  const source = parseImportSource(asString(args?.source));
  const result = asRecord(await kernel.request("pkg.add", {
    ...source,
    ref: asString(args?.ref) || "main",
    subdir: asString(args?.subdir) || ".",
  }));
  const pkg = asRecord(result?.package);
  if (!pkg) {
    throw new Error("Package import did not return a package.");
  }
  return { package: pkg as PackageRecord };
}

export async function createPackage(
  kernel: KernelClientLike,
  args: CreatePackageArgs,
): Promise<CreatePackageResult> {
  const result = asRecord(await kernel.request("pkg.create", {
    repo: asString(args?.repo),
    ref: asString(args?.ref) || undefined,
    subdir: asString(args?.subdir) || undefined,
    name: asString(args?.name) || undefined,
    displayName: asString(args?.displayName) || undefined,
    description: asString(args?.description) || undefined,
    template: args?.template === "command" ? "command" : "web-ui",
    command: asString(args?.command) || undefined,
    enable: args?.enable === true,
    overwrite: args?.overwrite === true,
  }));
  const pkg = asRecord(result?.package);
  if (!pkg) {
    throw new Error("Package creation did not return a package.");
  }
  return {
    package: pkg as PackageRecord,
    created: asBoolean(result?.created),
    files: asArray<string>(result?.files),
  };
}

export async function addCatalogRemote(
  kernel: KernelClientLike,
  args: AddCatalogRemoteArgs,
): Promise<unknown> {
  return kernel.request("pkg.remote.add", {
    name: asString(args?.name),
    baseUrl: asString(args?.baseUrl),
  });
}

export async function removeCatalogRemote(
  kernel: KernelClientLike,
  args: RemoveCatalogRemoteArgs,
): Promise<unknown> {
  return kernel.request("pkg.remote.remove", { name: asString(args?.name) });
}

export async function enablePackage(kernel: KernelClientLike, args: PackageIdArgs): Promise<unknown> {
  return kernel.request("pkg.install", { packageId: asString(args?.packageId) });
}

export async function disablePackage(kernel: KernelClientLike, args: PackageIdArgs): Promise<unknown> {
  return kernel.request("pkg.remove", { packageId: asString(args?.packageId) });
}

export async function approvePackageReview(kernel: KernelClientLike, args: PackageIdArgs): Promise<unknown> {
  return kernel.request("pkg.review.approve", { packageId: asString(args?.packageId) });
}

export async function refreshPackage(kernel: KernelClientLike, args: PackageIdArgs): Promise<unknown> {
  const packageId = asString(args?.packageId);
  const packages = await listPackages(kernel);
  const target = packages.find((pkg) => pkg.packageId === packageId);
  if (!target) {
    throw new Error(`Unknown package: ${packageId}`);
  }
  if (isBuiltinRepo(target.source.repo)) {
    return kernel.request("pkg.sync", {});
  }
  return kernel.request("pkg.checkout", {
    packageId: target.packageId,
    ref: target.source.ref,
  });
}

export async function pullPackage(kernel: KernelClientLike, args: PackageIdArgs): Promise<unknown> {
  const packageId = asString(args?.packageId);
  const packages = await listPackages(kernel);
  const target = packages.find((pkg) => pkg.packageId === packageId);
  if (!target) {
    throw new Error(`Unknown package: ${packageId}`);
  }
  return kernel.request("repo.import", {
    repo: target.source.repo,
    ref: target.source.ref,
    remoteRef: target.source.ref,
  });
}

export async function pullPackageSource(
  kernel: KernelClientLike,
  args: PullPackageSourceArgs,
): Promise<{ ok: boolean; imports: unknown[] }> {
  const repo = asString(args?.repo);
  if (!repo) {
    throw new Error("repo is required");
  }
  const packages = await listPackages(kernel);
  const sourcePackages = packages.filter((pkg) => pkg.source.repo === repo);
  if (sourcePackages.length === 0) {
    throw new Error(`Unknown source: ${repo}`);
  }
  const refs = unique(sourcePackages.map((pkg) => pkg.source.ref));
  const imports: unknown[] = [];
  for (const ref of refs) {
    imports.push(await kernel.request("repo.import", { repo, ref, remoteRef: ref }));
  }
  return { ok: true, imports };
}

export async function setPackagePublic(kernel: KernelClientLike, args: SetPackagePublicArgs): Promise<unknown> {
  return kernel.request("pkg.public.set", {
    packageId: asString(args?.packageId) || undefined,
    repo: asString(args?.repo) || undefined,
    public: args?.public === true,
  });
}

export async function startPackageReview(
  kernel: KernelClientLike,
  args: PackageIdArgs,
): Promise<StartPackageReviewResult> {
  const packageId = asString(args?.packageId);
  const packages = await listPackages(kernel);
  const target = packages.find((pkg) => pkg.packageId === packageId);
  if (!target) {
    throw new Error(`Unknown package: ${packageId}`);
  }

  const spawned = asRecord(await kernel.request("proc.spawn", {
    label: `Review ${target.name}`,
    prompt: buildReviewPrompt(target, packages),
    assignment: {
      contextFiles: [{
        name: "20-package-review.md",
        text: buildReviewAssignmentContext(target, packages),
      }],
    },
    mounts: [
      { kind: "package-source", packageId: target.packageId },
    ],
  }));

  if (!asBoolean(spawned?.ok)) {
    throw new Error(asString(spawned?.error) || "Failed to spawn review process");
  }

  return {
    pid: asString(spawned?.pid),
    cwd: asString(spawned?.cwd) || null,
  };
}
