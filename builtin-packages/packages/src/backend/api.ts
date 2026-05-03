import type {
  KernelClientLike,
  PackageViewerBinding,
} from "@gsv/package/backend";
import type {
  RepoDiffResult,
  RepoLogResult,
  RepoReadResult,
  RepoSearchResult,
} from "@gsv/protocol/syscalls/repositories";
import type {
  PackageRepoDiffResult,
  PackageRepoReadResult,
  PackageRepoSearchResult,
} from "../app/types";

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
    kind: "command" | "http" | "rpc" | "ui";
    description?: string;
    command?: string;
    route?: string;
    syscalls?: string[];
  }>;
  profiles?: Array<{
    name: string;
    displayName: string;
    description?: string;
    icon?: string;
  }>;
  bindingNames: string[];
  review: {
    required: boolean;
    approvedAt: number | null;
  };
  installedAt: number;
  updatedAt: number;
};

type ViewerRuntime = {
  viewer?: PackageViewerBinding;
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
  return repo === "root/gsv";
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

function canMutatePackage(pkg: PackageLike, viewer: ReturnType<typeof normalizeViewer>): boolean {
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
  const subdir = normalizeRepoPath(pkg.source.subdir);
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
    case "workspace":
      return `workspace:${pkg.scope.workspaceId ?? ""}:${pkg.packageId}`;
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
    `Review the imported package \"${pkg.name}\".`,
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
  const profiles = asArray<Record<string, unknown>>(pkg.profiles).map((profile) => ({
    name: asString(profile.name),
    displayName: asString(profile.displayName),
    description: asString(profile.description) || undefined,
    icon: asString(profile.icon) || undefined,
  }));
  const canMutate = canMutatePackage(pkg, viewer);
  const canChangeVisibility = viewer.isRoot || repoOwner(pkg.source.repo) === viewer.username;
  const canPullSource = canChangeVisibility && (isBuiltinRepo(pkg.source.repo) || pkg.review.required);
  return {
    ...pkg,
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
    pullable: boolean;
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
      pullable: pkg.canPullSource,
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
      ...source,
      packageNames: source.packageNames.sort((left, right) => left.localeCompare(right)),
      refreshable: !source.hasImmutablePackages,
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

async function loadPackageDetail(kernel: KernelClientLike, pkg: PackageLike) {
  const [refs, log] = await Promise.all([
    kernel.request("repo.refs", { repo: pkg.source.repo }),
    kernel.request("repo.log", {
      repo: pkg.source.repo,
      ref: pkg.source.ref,
      limit: 20,
      offset: 0,
    }) as Promise<RepoLogResult>,
  ]);
  const refsRecord = asRecord(refs);
  return {
    refs: {
      activeRef: pkg.source.ref,
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
  ctx: ViewerRuntime,
) {
  const viewer = normalizeViewer({
    uid: ctx.viewer?.uid ?? 0,
    username: ctx.viewer?.username ?? "",
  });
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
        packageDetail = await loadPackageDetail(kernel, target);
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

export async function syncSources(kernel: KernelClientLike, ctx: ViewerRuntime) {
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
  args: { source: string; ref?: string; subdir?: string },
) {
  const source = parseImportSource(asString(args.source));
  return kernel.request("pkg.add", {
    ...source,
    ref: asString(args.ref) || "main",
    subdir: asString(args.subdir) || ".",
  });
}

export async function createPackage(
  kernel: KernelClientLike,
  args: {
    repo: string;
    ref?: string;
    subdir?: string;
    name?: string;
    displayName?: string;
    description?: string;
    template?: "web-ui" | "command";
    command?: string;
    enable?: boolean;
    overwrite?: boolean;
  },
) {
  return kernel.request("pkg.create", {
    repo: asString(args.repo),
    ref: asString(args.ref) || undefined,
    subdir: asString(args.subdir) || undefined,
    name: asString(args.name) || undefined,
    displayName: asString(args.displayName) || undefined,
    description: asString(args.description) || undefined,
    template: args.template === "command" ? "command" : "web-ui",
    command: asString(args.command) || undefined,
    enable: args.enable === true,
    overwrite: args.overwrite === true,
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
  return kernel.request("pkg.checkout", {
    packageId: target.packageId,
    ref: target.source.ref,
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
  for (const pkg of sourcePackages) {
    await kernel.request("pkg.checkout", {
      packageId: pkg.packageId,
      ref: pkg.source.ref,
    });
  }
  return { ok: true };
}

export async function pullPackage(kernel: KernelClientLike, args: { packageId: string }) {
  const packages = await listPackages(kernel);
  const target = packages.find((pkg) => pkg.packageId === asString(args.packageId));
  if (!target) {
    throw new Error(`Unknown package: ${asString(args.packageId)}`);
  }
  return kernel.request("repo.import", {
    repo: target.source.repo,
    ref: target.source.ref,
  });
}

export async function pullSource(kernel: KernelClientLike, args: { repo: string }) {
  const repo = asString(args.repo);
  if (!repo) {
    throw new Error("repo is required");
  }
  const packages = await listPackages(kernel);
  const sourcePackages = packages.filter((pkg) => pkg.source.repo === repo);
  if (sourcePackages.length === 0) {
    throw new Error(`Unknown source: ${repo}`);
  }
  const refs = unique(sourcePackages.map((pkg) => pkg.source.ref));
  for (const ref of refs) {
    await kernel.request("repo.import", { repo, ref });
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
    prompt: buildReviewPrompt(target, packages),
    workspace: { mode: "none" },
    mounts: [
      { kind: "package-source", packageId: target.packageId },
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
): Promise<PackageRepoReadResult> {
  const target = await resolvePackageForRepo(kernel, args.packageId);
  const rootKind = args.root === "repo" ? "repo" : "package";
  const root = sourceRoot(target, rootKind);
  const path = normalizeRepoPath(args.path);
  const result = await kernel.request("repo.read", {
    repo: target.source.repo,
    ref: asString(args.ref) || target.source.ref,
    path: joinRepoPath(root, path) || undefined,
  }) as RepoReadResult;

  if (result.kind === "tree") {
    return {
      packageId: target.packageId,
      repo: result.repo,
      ref: result.ref,
      path,
      kind: "tree",
      entries: result.entries.map((entry) => ({
        ...entry,
        path: root ? trimRepoRoot(entry.path, root) : entry.path,
      })),
    };
  }

  return {
    packageId: target.packageId,
    repo: result.repo,
    ref: result.ref,
    path,
    kind: "file",
    size: result.size,
    isBinary: result.isBinary,
    content: result.content,
  };
}

export async function searchRepo(
  kernel: KernelClientLike,
  args: { packageId: string; ref?: string; query: string; prefix?: string; root?: "package" | "repo" },
): Promise<PackageRepoSearchResult> {
  const target = await resolvePackageForRepo(kernel, args.packageId);
  const rootKind = args.root === "repo" ? "repo" : "package";
  const root = sourceRoot(target, rootKind);
  const prefix = normalizeRepoPath(args.prefix);
  const result = await kernel.request("repo.search", {
    repo: target.source.repo,
    ref: asString(args.ref) || target.source.ref,
    query: asString(args.query),
    prefix: joinRepoPath(root, prefix) || undefined,
  }) as RepoSearchResult;

  return {
    packageId: target.packageId,
    repo: result.repo,
    ref: result.ref,
    query: result.query,
    prefix: prefix || undefined,
    root: rootKind,
    truncated: result.truncated,
    matches: result.matches.map((match) => ({
      ...match,
      path: root ? trimRepoRoot(match.path, root) : match.path,
    })),
  };
}

export async function diffRepo(
  kernel: KernelClientLike,
  args: { packageId: string; commit: string; context?: number },
): Promise<PackageRepoDiffResult> {
  const target = await resolvePackageForRepo(kernel, args.packageId);
  const result = await kernel.request("repo.diff", {
    repo: target.source.repo,
    commit: asString(args.commit),
    context: typeof args.context === "number" ? args.context : 3,
  }) as RepoDiffResult;

  return {
    packageId: target.packageId,
    repo: result.repo,
    ref: target.source.ref,
    commitHash: result.commitHash,
    parentHash: result.parentHash ?? null,
    stats: result.stats,
    files: result.files,
  };
}

async function resolvePackageForRepo(kernel: KernelClientLike, packageId: string): Promise<PackageLike> {
  const normalizedPackageId = asString(packageId).trim();
  if (!normalizedPackageId) {
    throw new Error("packageId is required");
  }
  const packages = await listPackages(kernel);
  const target = packages.find((pkg) => pkg.packageId === normalizedPackageId);
  if (!target) {
    throw new Error(`Unknown package: ${normalizedPackageId}`);
  }
  return target;
}

function sourceRoot(pkg: PackageLike, root: "package" | "repo"): string {
  return root === "repo" ? "" : normalizeRepoPath(pkg.source.subdir);
}

function normalizeRepoPath(path: string | undefined): string {
  const raw = typeof path === "string" ? path.trim() : "";
  const parts: string[] = [];
  for (const segment of raw.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === ".." || segment.includes("\0")) {
      throw new Error(`Invalid repo path: ${path}`);
    }
    parts.push(segment);
  }
  return parts.join("/");
}

function joinRepoPath(base: string, child: string): string {
  if (!base) return child;
  if (!child) return base;
  return `${base}/${child}`;
}

function trimRepoRoot(path: string, root: string): string {
  if (!root) {
    return path;
  }
  const normalizedPath = normalizeRepoPath(path);
  if (!normalizedPath || normalizedPath === root) {
    return "";
  }
  const prefix = `${root}/`;
  return normalizedPath.startsWith(prefix) ? normalizedPath.slice(prefix.length) : normalizedPath;
}
