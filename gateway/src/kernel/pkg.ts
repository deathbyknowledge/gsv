import type { KernelContext } from "./context";
import type {
  PkgAddArgs,
  PkgAddResult,
  PkgCheckoutArgs,
  PkgCheckoutResult,
  PkgInstallArgs,
  PkgInstallResult,
  PkgReviewApproveArgs,
  PkgReviewApproveResult,
  PkgListArgs,
  PkgListResult,
  PkgSyncArgs,
  PkgSyncResult,
  PkgRemoteAddArgs,
  PkgRemoteAddResult,
  PkgRemoteEntry,
  PkgRemoteListArgs,
  PkgRemoteListResult,
  PkgRemoteRemoveArgs,
  PkgRemoteRemoveResult,
  PkgRemoveArgs,
  PkgRemoveResult,
  PkgPublicListArgs,
  PkgPublicListResult,
  PkgPublicSetArgs,
  PkgPublicSetResult,
  PkgCatalogEntry,
  PkgSummary,
} from "@gsv/protocol/syscalls/packages";
import type {
  InstalledPackageRecord,
  PackageBindingGrant,
  PackageEntrypoint,
  PackageGrantSet,
  PackageInstallScope,
  PackageManifest,
} from "./packages";
import {
  buildBuiltinPackageSeeds,
  defaultPackageInstallScopeForActor,
  packageScopeEquals,
  resolvePackageFromRipgitSource,
  visiblePackageScopesForActor,
} from "./packages";
import { RipgitClient, type RipgitRepoRef } from "../fs/ripgit/client";

export function handlePkgList(
  args: PkgListArgs | undefined,
  ctx: KernelContext,
): PkgListResult {
  return {
    packages: ctx.packages.list({
      enabled: typeof args?.enabled === "boolean" ? args.enabled : undefined,
      name: typeof args?.name === "string" && args.name.trim().length > 0 ? args.name.trim() : undefined,
      runtime: args?.runtime,
      scopes: visiblePackageScopesForActor(ctx.identity?.process),
    }).map((record) => toPkgSummary(record, ctx)),
  };
}

export function handlePkgRemoteList(
  _args: PkgRemoteListArgs | undefined,
  ctx: KernelContext,
): PkgRemoteListResult {
  const identity = requireIdentity(ctx);
  return {
    remotes: listPkgRemotes(ctx, identity.process.uid),
  };
}

export function handlePkgRemoteAdd(
  args: PkgRemoteAddArgs,
  ctx: KernelContext,
): PkgRemoteAddResult {
  const identity = requireIdentity(ctx);
  const name = normalizeRemoteName(args.name);
  const baseUrl = normalizeRemoteBaseUrl(args.baseUrl);
  const key = remoteConfigKey(identity.process.uid, name);
  const existing = ctx.config.get(key);
  ctx.config.set(key, baseUrl);
  return {
    changed: existing !== baseUrl,
    remote: { name, baseUrl },
    remotes: listPkgRemotes(ctx, identity.process.uid),
  };
}

export function handlePkgRemoteRemove(
  args: PkgRemoteRemoveArgs,
  ctx: KernelContext,
): PkgRemoteRemoveResult {
  const identity = requireIdentity(ctx);
  const removed = ctx.config.delete(remoteConfigKey(identity.process.uid, normalizeRemoteName(args.name)));
  return {
    removed,
    remotes: listPkgRemotes(ctx, identity.process.uid),
  };
}

export function handlePkgInstall(
  args: PkgInstallArgs,
  ctx: KernelContext,
): PkgInstallResult {
  const record = requirePackage(args.packageId, ctx);
  assertMutablePackageAccess(record, ctx);
  if (record.reviewRequired && !record.reviewedAt) {
    throw new Error(`Package review approval required before enabling: ${record.manifest.name}`);
  }
  if (!record.enabled) {
    const updated = ctx.packages.setEnabled(record.packageId, true, record.scope);
    if (!updated) {
      throw new Error(`Failed to enable package: ${record.packageId}`);
    }
  }

  return {
    changed: !record.enabled,
    package: toPkgSummary(requirePackage(record.packageId, ctx), ctx),
  };
}

export function handlePkgReviewApprove(
  args: PkgReviewApproveArgs,
  ctx: KernelContext,
): PkgReviewApproveResult {
  const record = requirePackage(args.packageId, ctx);
  assertMutablePackageAccess(record, ctx);
  if (!record.reviewRequired) {
    return {
      changed: false,
      package: toPkgSummary(record, ctx),
    };
  }

  const approvedAt = record.reviewedAt ?? Date.now();
  const updated = ctx.packages.setReviewed(record.packageId, approvedAt, record.scope);
  if (!updated) {
    throw new Error(`Failed to mark package as reviewed: ${record.packageId}`);
  }

  return {
    changed: record.reviewedAt == null,
    package: toPkgSummary(requirePackage(record.packageId, ctx), ctx),
  };
}

export async function handlePkgPublicList(
  args: PkgPublicListArgs | undefined,
  ctx: KernelContext,
): Promise<PkgPublicListResult> {
  const identity = requireIdentity(ctx);
  const requestedRemote = typeof args?.remote === "string" ? args.remote.trim() : "";
  if (!requestedRemote || requestedRemote === "local") {
    const serverName = configuredServerName(ctx);
    return {
      serverName,
      source: { kind: "local", name: serverName },
      packages: listLocalPublicPackages(ctx.config, ctx.packages),
    };
  }

  const remote = resolvePkgRemote(ctx, identity.process.uid, requestedRemote);
  const response = await fetch(`${remote.baseUrl}/public/packages`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Failed to load public packages from ${remote.name}: ${response.status}`);
  }

  const payload = await response.json<Partial<PkgPublicListResult>>();
  const packages = Array.isArray(payload?.packages)
    ? payload.packages.map(normalizeCatalogEntry).filter(Boolean) as PkgCatalogEntry[]
    : [];
  return {
    serverName: typeof payload?.serverName === "string" && payload.serverName.trim().length > 0
      ? payload.serverName.trim()
      : remote.name,
    source: { kind: "remote", name: remote.name, baseUrl: remote.baseUrl },
    packages,
  };
}

export function handlePkgPublicSet(
  args: PkgPublicSetArgs,
  ctx: KernelContext,
): PkgPublicSetResult {
  const identity = requireIdentity(ctx);
  const repo = resolvePublicRepoTarget(args, ctx);
  assertRepoOwnerOrRoot(repo, identity);
  const key = publicRepoConfigKey(repo);
  const nextPublic = args.public === true;
  const wasPublic = ctx.config.get(key) === "true";
  if (nextPublic) {
    ctx.config.set(key, "true");
  } else {
    ctx.config.delete(key);
  }
  return {
    changed: wasPublic !== nextPublic,
    repo,
    public: nextPublic,
  };
}

export async function handlePkgAdd(
  args: PkgAddArgs,
  ctx: KernelContext,
): Promise<PkgAddResult> {
  const upstream = resolveUpstream(args);
  const repo = resolveImportRepo(ctx, upstream);
  const ref = upstream.ref;
  const subdir = normalizeRepoPath(args.subdir) || ".";
  const ripgit = requireRipgitClient(ctx);
  const actorName = requireIdentity(ctx).process.username;
  const imported = await ripgit.importFromUpstream(
    repo,
    actorName,
    `${actorName}@gsv.local`,
    `import ${upstream.remoteUrl}#${upstream.ref}`,
    upstream.remoteUrl,
    upstream.ref,
  );

  const resolved = await resolvePackageFromRipgitSource(ctx.env, {
    repo: `${repo.owner}/${repo.repo}`,
    ref,
    subdir,
  });
  const packageId = packageIdForSource(resolved.manifest);
  const scope = installScopeForActor(ctx);
  const existing = ctx.packages.get(packageId, scope);
  const isSystemSource = resolved.manifest.source.repo === "system/gsv";
  const requestedEnable = typeof args.enable === "boolean" ? args.enable : undefined;
  const enabled = isSystemSource
    ? (requestedEnable ?? existing?.enabled ?? true)
    : (existing?.enabled ?? false);
  const grants = grantsForManifest(resolved.manifest, scope);
  const updated = await ctx.packages.install({
    packageId,
    scope,
    manifest: resolved.manifest,
    artifact: resolved.artifact,
    grants,
    enabled,
    reviewRequired: !isSystemSource,
    reviewedAt: isSystemSource ? Date.now() : existing?.reviewedAt ?? null,
    installedAt: existing?.installedAt,
    updatedAt: Date.now(),
  });

  return {
    changed:
      !existing ||
      existing.enabled !== updated.enabled ||
      existing.artifact.hash !== updated.artifact.hash ||
      existing.manifest.source.ref !== updated.manifest.source.ref ||
      (existing.manifest.source.resolvedCommit ?? null) !== (updated.manifest.source.resolvedCommit ?? null),
    imported: {
      repo: `${repo.owner}/${repo.repo}`,
      remoteUrl: imported.remoteUrl,
      ref: imported.remoteRef,
      head: imported.head ?? null,
    },
    package: toPkgSummary(updated, ctx),
  };
}

export async function handlePkgSync(
  _args: PkgSyncArgs | undefined,
  ctx: KernelContext,
): Promise<PkgSyncResult> {
  const builtinSeeds = await buildBuiltinPackageSeeds(ctx.env);
  const installed = await ctx.packages.seedBuiltinPackages(builtinSeeds);
  return {
    packages: installed.map((record) => toPkgSummary(record, ctx)),
  };
}

export async function handlePkgCheckout(
  args: PkgCheckoutArgs,
  ctx: KernelContext,
): Promise<PkgCheckoutResult> {
  const record = requirePackage(args.packageId, ctx);
  assertMutablePackageAccess(record, ctx);
  const ref = typeof args.ref === "string" ? args.ref.trim() : "";
  if (!ref) {
    throw new Error("ref is required");
  }

  const source = {
    ...record.manifest.source,
    ref,
    resolvedCommit: null,
  };
  const resolved = await resolvePackageFromRipgitSource(ctx.env, source);
  if (resolved.manifest.name !== record.manifest.name) {
    throw new Error(`Package source mismatch: expected ${record.manifest.name}, got ${resolved.manifest.name}`);
  }

  const updated = await ctx.packages.install({
    packageId: record.packageId,
    scope: record.scope,
    manifest: resolved.manifest,
    artifact: resolved.artifact,
    grants: record.grants,
    enabled: record.enabled,
    reviewRequired: record.reviewRequired,
    reviewedAt: record.reviewedAt ?? null,
    installedAt: record.installedAt,
    updatedAt: Date.now(),
  });

  return {
    changed:
      record.manifest.source.ref !== ref ||
      (record.manifest.source.resolvedCommit ?? null) !== (updated.manifest.source.resolvedCommit ?? null) ||
      record.artifact.hash !== updated.artifact.hash,
    package: toPkgSummary(updated, ctx),
  };
}

export function handlePkgRemove(
  args: PkgRemoveArgs,
  ctx: KernelContext,
): PkgRemoveResult {
  const record = requirePackage(args.packageId, ctx);
  assertMutablePackageAccess(record, ctx);
  if (record.manifest.name === "packages") {
    throw new Error("Cannot remove the packages manager");
  }
  if (record.enabled) {
    const updated = ctx.packages.setEnabled(record.packageId, false, record.scope);
    if (!updated) {
      throw new Error(`Failed to disable package: ${record.packageId}`);
    }
  }

  return {
    changed: record.enabled,
    package: toPkgSummary(requirePackage(record.packageId, ctx), ctx),
  };
}

export function resolveInstalledPackage(packageId: string, ctx: KernelContext): InstalledPackageRecord {
  const normalizedPackageId = typeof packageId === "string" ? packageId.trim() : "";
  if (!normalizedPackageId) {
    throw new Error("packageId is required");
  }

  const scopes = visiblePackageScopesForActor(ctx.identity?.process);
  const record = ctx.packages.resolve(normalizedPackageId, scopes);
  if (!record) {
    const candidates = ctx.packages.list({ scopes }).filter((candidate) => {
      const sourceRepo = candidate.manifest.source.repo;
      const normalizedSubdir = normalizeRepoPath(candidate.manifest.source.subdir) || ".";
      const importRepoAlias = `import:${sourceRepo}`;
      const importPathAlias = `import:${sourceRepo}:${normalizedSubdir}`;
      return (
        candidate.manifest.name === normalizedPackageId ||
        sourceRepo === normalizedPackageId ||
        importRepoAlias === normalizedPackageId ||
        importPathAlias === normalizedPackageId
      );
    });

    if (candidates.length === 1) {
      return candidates[0];
    }
    if (candidates.length > 1) {
      throw new Error(`Ambiguous package reference: ${normalizedPackageId}`);
    }
    throw new Error(`Unknown package: ${normalizedPackageId}`);
  }
  return record;
}

function requirePackage(packageId: string, ctx: KernelContext): InstalledPackageRecord {
  return resolveInstalledPackage(packageId, ctx);
}

function resolveUpstream(args: PkgAddArgs): { remoteUrl: string; ref: string; repoSlug: string | null } {
  const remoteUrl = typeof args.remoteUrl === "string" ? args.remoteUrl.trim() : "";
  const repoSlug = typeof args.repo === "string" ? args.repo.trim().replace(/^\/+|\/+$/g, "") : "";
  const ref = typeof args.ref === "string" && args.ref.trim().length > 0 ? args.ref.trim() : "main";
  if (remoteUrl) {
    return {
      remoteUrl,
      ref,
      repoSlug: null,
    };
  }
  if (!repoSlug || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repoSlug)) {
    throw new Error("repo or remoteUrl is required");
  }
  return {
    remoteUrl: `https://github.com/${repoSlug}`,
    ref,
    repoSlug,
  };
}

function resolveImportRepo(
  ctx: KernelContext,
  upstream: { remoteUrl: string; repoSlug: string | null },
): RipgitRepoRef {
  const owner = requireIdentity(ctx).process.username;
  const nameSource = upstream.repoSlug
    ? upstream.repoSlug.split("/")[1]
    : repoBasenameFromUrl(upstream.remoteUrl);
  const repoName = sanitizeRepoName(nameSource);
  if (!repoName) {
    throw new Error("Could not derive local repo name");
  }
  return {
    owner,
    repo: repoName,
    branch: "main",
  };
}

function repoBasenameFromUrl(remoteUrl: string): string {
  const scpStyle = remoteUrl.match(/^[^@]+@[^:]+:(.+)$/);
  if (scpStyle?.[1]) {
    const last = scpStyle[1].replace(/\/+$/, "").split("/").filter(Boolean).pop() ?? "";
    return last.replace(/\.git$/i, "");
  }
  try {
    const url = new URL(remoteUrl);
    const pathname = url.pathname.replace(/\/+$/, "");
    const last = pathname.split("/").filter(Boolean).pop() ?? "";
    return last.replace(/\.git$/i, "");
  } catch {
    return "";
  }
}

function sanitizeRepoName(value: string): string {
  const trimmed = value.trim().replace(/\.git$/i, "").toLowerCase();
  const normalized = trimmed.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return /^[a-z0-9._-]+$/.test(normalized) ? normalized : "";
}

function packageIdForSource(manifest: PackageManifest): string {
  const source = manifest.source;
  return `import:${source.repo}:${normalizeRepoPath(source.subdir) || "."}`;
}

function grantsForManifest(manifest: PackageManifest, scope: PackageInstallScope): PackageGrantSet {
  const bindings = manifest.capabilities?.bindings ?? [];
  return {
    bindings: bindings.flatMap<PackageBindingGrant>((binding): PackageBindingGrant[] => {
      if (binding.binding === "KERNEL") {
        return [{
          binding: "KERNEL",
          providerKind: "kernel-entrypoint" as const,
          providerRef: "kernel://app/request",
        }];
      }
      return [];
    }),
    egress: manifest.capabilities?.egress ?? {
      mode: "none",
    },
  };
}

function requireIdentity(ctx: KernelContext): NonNullable<KernelContext["identity"]> {
  if (!ctx.identity) {
    throw new Error("Authenticated identity required");
  }
  return ctx.identity;
}

function installScopeForActor(ctx: KernelContext): PackageInstallScope {
  return defaultPackageInstallScopeForActor(requireIdentity(ctx).process);
}

function assertMutablePackageAccess(record: InstalledPackageRecord, ctx: KernelContext): void {
  const identity = requireIdentity(ctx);
  if (identity.process.uid === 0 || (identity.capabilities ?? []).includes("*")) {
    return;
  }
  if (packageScopeEquals(record.scope, { kind: "user", uid: identity.process.uid })) {
    return;
  }
  throw new Error(`Forbidden: ${record.packageId} is not installed in your package scope`);
}

export function listLocalPublicPackages(
  config: KernelContext["config"],
  packages: KernelContext["packages"],
): PkgCatalogEntry[] {
  return packages
    .list({})
    .filter((record) => isRepoPublic(record.manifest.source.repo, config))
    .sort((left, right) => left.manifest.name.localeCompare(right.manifest.name))
    .map(toCatalogEntry);
}

function toPkgSummary(record: InstalledPackageRecord, ctx: KernelContext): PkgSummary {
  return {
    packageId: record.packageId,
    scope: {
      kind: record.scope.kind,
      uid: record.scope.kind === "user" ? record.scope.uid : undefined,
      workspaceId: record.scope.kind === "workspace" ? record.scope.workspaceId : undefined,
    },
    name: record.manifest.name,
    description: record.manifest.description,
    version: record.manifest.version,
    runtime: record.manifest.runtime,
    enabled: record.enabled,
    source: {
      repo: record.manifest.source.repo,
      ref: record.manifest.source.ref,
      subdir: record.manifest.source.subdir,
      resolvedCommit: record.manifest.source.resolvedCommit ?? null,
      public: isRepoPublic(record.manifest.source.repo, ctx.config),
    },
    entrypoints: record.manifest.entrypoints.map((entrypoint) => ({
      name: entrypoint.name,
      kind: entrypoint.kind,
      description: entrypoint.description,
      command: entrypoint.command,
      route: entrypoint.route,
      icon: entrypoint.icon,
      syscalls: entrypoint.syscalls,
      windowDefaults: entrypoint.windowDefaults,
    })),
    bindingNames: (record.manifest.capabilities?.bindings ?? []).map((binding) => binding.binding),
    review: {
      required: record.reviewRequired,
      approvedAt: record.reviewedAt ?? null,
    },
    installedAt: record.installedAt,
    updatedAt: record.updatedAt,
  };
}

function toCatalogEntry(record: InstalledPackageRecord): PkgCatalogEntry {
  return {
    name: record.manifest.name,
    description: record.manifest.description,
    version: record.manifest.version,
    runtime: record.manifest.runtime,
    source: {
      repo: record.manifest.source.repo,
      ref: record.manifest.source.ref,
      subdir: record.manifest.source.subdir,
      resolvedCommit: record.manifest.source.resolvedCommit ?? null,
    },
    entrypoints: record.manifest.entrypoints.map((entrypoint) => ({
      name: entrypoint.name,
      kind: entrypoint.kind,
      description: entrypoint.description,
      command: entrypoint.command,
      route: entrypoint.route,
      icon: entrypoint.icon,
      syscalls: entrypoint.syscalls,
      windowDefaults: entrypoint.windowDefaults,
    })),
    bindingNames: (record.manifest.capabilities?.bindings ?? []).map((binding) => binding.binding),
  };
}

function requireRipgitClient(ctx: KernelContext): RipgitClient {
  const ripgitBinding = ctx.env.RIPGIT;
  if (!ripgitBinding) {
    throw new Error("RIPGIT binding is required");
  }
  return new RipgitClient(ripgitBinding);
}

function normalizeRepoPath(path: string | undefined): string {
  const trimmed = typeof path === "string" ? path.trim() : "";
  return trimmed.replace(/^\/+/, "").replace(/\/+$/, "");
}

function configuredServerName(ctx: KernelContext): string {
  const configured = ctx.config.get("config/server/name")?.trim();
  return configured && configured.length > 0 ? configured : "gsv";
}

function publicRepoConfigKey(repo: string): string {
  return `config/pkg/public-repos/${repo}`;
}

export function isRepoPublic(repo: string, config: KernelContext["config"]): boolean {
  return config.get(publicRepoConfigKey(repo)) === "true";
}

function listPkgRemotes(ctx: KernelContext, uid: number): PkgRemoteEntry[] {
  const prefix = `users/${uid}/pkg/remotes/`;
  return ctx.config
    .list(prefix)
    .map(({ key, value }) => ({
      name: key.slice(prefix.length),
      baseUrl: value,
    }))
    .filter((entry) => entry.name.length > 0 && entry.baseUrl.length > 0)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function remoteConfigKey(uid: number, name: string): string {
  return `users/${uid}/pkg/remotes/${name}`;
}

function normalizeRemoteName(raw: string): string {
  const name = raw.trim();
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(name)) {
    throw new Error("Remote name must be alphanumeric and may include dashes");
  }
  return name;
}

function normalizeRemoteBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw new Error("Remote URL is required");
  }
  const url = new URL(trimmed);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Remote URL must use http or https");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

function resolvePkgRemote(ctx: KernelContext, uid: number, raw: string): PkgRemoteEntry {
  if (raw.includes("://")) {
    const baseUrl = normalizeRemoteBaseUrl(raw);
    return {
      name: new URL(baseUrl).host,
      baseUrl,
    };
  }
  const name = normalizeRemoteName(raw);
  const baseUrl = ctx.config.get(remoteConfigKey(uid, name));
  if (!baseUrl) {
    throw new Error(`Unknown package remote: ${name}`);
  }
  return { name, baseUrl };
}

function resolvePublicRepoTarget(args: PkgPublicSetArgs, ctx: KernelContext): string {
  const repo = typeof args.repo === "string" ? args.repo.trim() : "";
  if (repo) {
    const parsed = parseSyncRepoRef(repo);
    return `${parsed.owner}/${parsed.repo}`;
  }
  const packageId = typeof args.packageId === "string" ? args.packageId.trim() : "";
  if (!packageId) {
    throw new Error("packageId or repo is required");
  }
  return requirePackage(packageId, ctx).manifest.source.repo;
}

function assertRepoOwnerOrRoot(
  repo: string,
  identity: NonNullable<KernelContext["identity"]>,
): void {
  const { owner } = parseSyncRepoRef(repo);
  if (identity.process.uid === 0 || identity.process.username === owner) {
    return;
  }
  if ((identity.capabilities ?? []).includes("*")) {
    return;
  }
  throw new Error(`Forbidden: only ${owner} or root may change visibility for ${repo}`);
}

function normalizeCatalogEntry(entry: unknown): PkgCatalogEntry | null {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const value = entry as Record<string, unknown>;
  const source = value.source;
  if (!source || typeof source !== "object") {
    return null;
  }
  const sourceRecord = source as Record<string, unknown>;
  const repo = typeof sourceRecord.repo === "string" ? sourceRecord.repo.trim() : "";
  const ref = typeof sourceRecord.ref === "string" ? sourceRecord.ref.trim() : "main";
  const subdir = typeof sourceRecord.subdir === "string" ? sourceRecord.subdir.trim() || "." : ".";
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name || !repo) {
    return null;
  }
  return {
    name,
    description: typeof value.description === "string" ? value.description : "",
    version: typeof value.version === "string" ? value.version : "0.0.0",
    runtime: value.runtime === "dynamic-worker" || value.runtime === "node" || value.runtime === "web-ui"
      ? value.runtime
      : "dynamic-worker",
    source: {
      repo,
      ref,
      subdir,
      resolvedCommit: typeof sourceRecord.resolvedCommit === "string" ? sourceRecord.resolvedCommit : null,
    },
    entrypoints: Array.isArray(value.entrypoints) ? value.entrypoints as PkgCatalogEntry["entrypoints"] : [],
    bindingNames: Array.isArray(value.bindingNames) ? value.bindingNames.filter((item): item is string => typeof item === "string") : [],
  };
}

function parseSyncRepoRef(repo: string): RipgitRepoRef {
  const [owner, name] = repo.split("/", 2);
  if (!owner || !name) {
    throw new Error(`repo must be '<owner>/<repo>', got '${repo}'`);
  }
  return {
    owner,
    repo: name,
  };
}
