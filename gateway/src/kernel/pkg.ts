import type { KernelContext } from "./context";
import { resolveCallerOwnerUid } from "./context";
import { provisionEnabledPackagesForCaller, provisionPackageAgents, revokePackageAgentAccess } from "./package-agents";
import type {
  PkgAddArgs,
  PkgAddResult,
  PkgCheckoutArgs,
  PkgCheckoutResult,
  PkgCreateArgs,
  PkgCreateResult,
  PkgCreateTemplate,
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
} from "@humansandmachines/gsv/protocol";
import type {
  InstalledPackageRecord,
  PackageBindingGrant,
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
import { isRepoPublic, setRepoVisibility } from "./repo-visibility";
import { RipgitClient, type RipgitRepoRef } from "../fs/ripgit/client";

export { isRepoPublic } from "./repo-visibility";

const DEFAULT_PACKAGE_CREATE_REF = "main";
const TEXT_ENCODER = new TextEncoder();

export function handlePkgList(
  args: PkgListArgs | undefined,
  ctx: KernelContext,
): PkgListResult {
  return {
    packages: ctx.packages.list({
      enabled: typeof args?.enabled === "boolean" ? args.enabled : undefined,
      name: typeof args?.name === "string" && args.name.trim().length > 0 ? args.name.trim() : undefined,
      runtime: args?.runtime,
      scopes: visiblePackageScopesForContext(ctx),
    }).map((record) => toPkgSummary(record, ctx)),
  };
}

export function handlePkgRemoteList(
  _args: PkgRemoteListArgs | undefined,
  ctx: KernelContext,
): PkgRemoteListResult {
  const ownerUid = remoteConfigOwnerUid(ctx);
  return {
    remotes: listPkgRemotes(ctx, ownerUid),
  };
}

export function handlePkgRemoteAdd(
  args: PkgRemoteAddArgs,
  ctx: KernelContext,
): PkgRemoteAddResult {
  const ownerUid = remoteConfigOwnerUid(ctx);
  const name = normalizeRemoteName(args.name);
  const baseUrl = normalizeRemoteBaseUrl(args.baseUrl);
  const key = remoteConfigKey(ownerUid, name);
  const existing = ctx.config.get(key);
  ctx.config.set(key, baseUrl);
  return {
    changed: existing !== baseUrl,
    remote: { name, baseUrl },
    remotes: listPkgRemotes(ctx, ownerUid),
  };
}

export function handlePkgRemoteRemove(
  args: PkgRemoteRemoveArgs,
  ctx: KernelContext,
): PkgRemoteRemoveResult {
  const ownerUid = remoteConfigOwnerUid(ctx);
  const removed = ctx.config.delete(remoteConfigKey(ownerUid, normalizeRemoteName(args.name)));
  return {
    removed,
    remotes: listPkgRemotes(ctx, ownerUid),
  };
}

export async function handlePkgInstall(
  args: PkgInstallArgs,
  ctx: KernelContext,
): Promise<PkgInstallResult> {
  const record = requirePackage(args.packageId, ctx);
  assertMutablePackageAccess(record, ctx);
  if (record.reviewRequired && !record.reviewedAt) {
    throw new Error(`Package review approval required before enabling: ${record.manifest.name}`);
  }

  // Provision the package's agent accounts and grant the enabling human run-as
  // rights. The enabler is the owning human, not the run-as account: when
  // pkg.install runs from a process (the normal personal-agent path),
  // ctx.identity.process.uid is the agent's uid, but proc.spawn authorizes the
  // access group against the process owner — so the access group must be granted
  // to the same human. Idempotent, so re-enabling for another human just adds
  // them.
  const enablingHumanUid = ctx.identity ? resolveCallerOwnerUid(ctx) : undefined;
  if (typeof enablingHumanUid === "number" && (record.manifest.profiles?.length ?? 0) > 0) {
    await provisionPackageAgents(ctx, record, enablingHumanUid);
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
  requireIdentity(ctx);
  const requestedRemote = typeof args?.remote === "string" ? args.remote.trim() : "";
  if (!requestedRemote || requestedRemote === "local") {
    const serverName = configuredServerName(ctx);
    return {
      serverName,
      source: { kind: "local", name: serverName },
      packages: listLocalPublicPackages(ctx.config, ctx.packages),
    };
  }

  const ownerUid = resolveCallerOwnerUid(ctx);
  const remote = resolvePkgRemote(ctx, ownerUid, requestedRemote);
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
  const nextPublic = args.public === true;
  const wasPublic = isRepoPublic(repo, ctx.config);
  setRepoVisibility(repo, nextPublic ? "public" : "private", ctx.config);
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
  if (imported.diverged) {
    throw new Error(
      `Package source ${repoSlug(repo)}#${ref} has local commits; fetched upstream into ${imported.trackingRef ?? "the upstream tracking ref"} but did not move the local branch.`,
    );
  }

  const resolved = await resolvePackageFromRipgitSource(ctx.env, {
    repo: `${repo.owner}/${repo.repo}`,
    ref,
    subdir,
  });
  const packageId = packageIdForSource(resolved.manifest);
  const scope = installScopeForActor(ctx);
  const existing = ctx.packages.get(packageId, scope);
  const isBuiltinSource = resolved.manifest.source.repo === "root/gsv";
  const requestedEnable = typeof args.enable === "boolean" ? args.enable : undefined;
  const enabled = isBuiltinSource
    ? (requestedEnable ?? existing?.enabled ?? true)
    : (existing?.enabled ?? false);
  const grants = grantsForManifest(resolved.manifest);
  const updated = await ctx.packages.install({
    packageId,
    scope,
    manifest: resolved.manifest,
    artifact: resolved.artifact,
    grants,
    enabled,
    reviewRequired: !isBuiltinSource,
    reviewedAt: isBuiltinSource ? Date.now() : existing?.reviewedAt ?? null,
    installedAt: existing?.installedAt,
    updatedAt: Date.now(),
  });
  await provisionEnabledPackageAgentsForCaller(ctx, updated);

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

export async function handlePkgCreate(
  args: PkgCreateArgs,
  ctx: KernelContext,
): Promise<PkgCreateResult> {
  const identity = requireIdentity(ctx);
  const repo = resolveCreateRepo(args.repo, identity.process.username);
  assertRepoOwnerOrRoot(repoSlug(repo), identity);
  const ref = normalizePackageCreateRef(args.ref);
  const subdir = normalizeRepoPath(args.subdir) || ".";
  const template = normalizePackageCreateTemplate(args.template);
  const packageName = normalizePackageJsonName(args.name, repo);
  const displayName = normalizePackageDisplayName(args.displayName, repo.repo);
  const description = normalizePackageDescription(args.description, displayName);
  const command = normalizePackageCommandName(args.command, repo.repo);
  const files = buildPackageScaffold({
    packageName,
    displayName,
    description,
    template,
    command,
  });
  const ops = Object.entries(files).map(([path, content]) => ({
    type: "put" as const,
    path: joinPackageSourcePath(subdir, path),
    contentBytes: Array.from(TEXT_ENCODER.encode(content)),
  }));

  const ripgit = requireRipgitClient(ctx);
  const refs = await ripgit.refs(repo);
  const applyOptions = packageCreateApplyOptions(ref, refs.heads);
  const existingRef = refs.heads?.[ref] ? ref : applyOptions?.baseRef ?? ref;
  const target = await inspectPackageCreateTarget(ripgit, { ...repo, branch: existingRef }, subdir);
  if (target.kind === "file") {
    throw new Error(`Package source path is a file at ${repoSlug(repo)}:${subdir}`);
  }
  if (target.nonEmpty && args.overwrite !== true) {
    throw new Error(
      `Package source path is not empty at ${repoSlug(repo)}:${subdir}. Pass overwrite to replace the scaffold files.`,
    );
  }
  const created = !target.hasPackageJson;

  const result = await ripgit.apply(
    { ...repo, branch: ref },
    identity.process.username,
    `${identity.process.username}@gsv.local`,
    created ? `pkg: create ${packageName}` : `pkg: update scaffold for ${packageName}`,
    ops,
    applyOptions,
  );
  registerPackageRepo(ctx, repo, description);

  const source = {
    repo: repoSlug(repo),
    ref,
    subdir,
  };
  const resolved = await resolvePackageFromRipgitSource(ctx.env, source);
  const packageId = packageIdForSource(resolved.manifest);
  const scope = installScopeForActor(ctx);
  const existing = ctx.packages.get(packageId, scope);
  const enabled = typeof args.enable === "boolean"
    ? args.enable
    : existing?.enabled ?? false;
  const reviewedAt = existing?.reviewedAt ?? Date.now();
  const updated = await ctx.packages.install({
    packageId,
    scope,
    manifest: resolved.manifest,
    artifact: resolved.artifact,
    grants: grantsForManifest(resolved.manifest),
    enabled,
    reviewRequired: false,
    reviewedAt,
    installedAt: existing?.installedAt,
    updatedAt: Date.now(),
  });
  await provisionEnabledPackageAgentsForCaller(ctx, updated);

  return {
    changed:
      !existing ||
      existing.enabled !== updated.enabled ||
      existing.artifact.hash !== updated.artifact.hash ||
      existing.manifest.source.ref !== updated.manifest.source.ref ||
      (existing.manifest.source.resolvedCommit ?? null) !== (updated.manifest.source.resolvedCommit ?? null),
    created,
    repo: repoSlug(repo),
    ref,
    subdir,
    head: result.head ?? null,
    files: Object.keys(files).map((path) => joinPackageSourcePath(subdir, path)),
    package: toPkgSummary(updated, ctx),
  };
}

export async function handlePkgSync(
  _args: PkgSyncArgs | undefined,
  ctx: KernelContext,
): Promise<PkgSyncResult> {
  const builtinSeeds = await buildBuiltinPackageSeeds(ctx.env);
  const installed = await ctx.packages.seedBuiltinPackages(builtinSeeds);
  await provisionEnabledPackagesForCaller(ctx, installed);
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
  await provisionEnabledPackageAgentsForCaller(ctx, updated);

  return {
    changed:
      record.manifest.source.ref !== ref ||
      (record.manifest.source.resolvedCommit ?? null) !== (updated.manifest.source.resolvedCommit ?? null) ||
      record.artifact.hash !== updated.artifact.hash,
    package: toPkgSummary(updated, ctx),
  };
}

export async function handlePkgRemove(
  args: PkgRemoveArgs,
  ctx: KernelContext,
): Promise<PkgRemoveResult> {
  const record = requirePackage(args.packageId, ctx);
  assertMutablePackageAccess(record, ctx);
  if (isRequiredSystemConsolePackage(record)) {
    throw new Error("Cannot remove the system console package");
  }
  if (record.enabled) {
    const updated = ctx.packages.setEnabled(record.packageId, false, record.scope);
    if (!updated) {
      throw new Error(`Failed to disable package: ${record.packageId}`);
    }
  }

  // Revoke the disabling human's run-as rights for this package's agents. Use
  // the owning human (not the run-as account): from a personal-agent process,
  // ctx.identity.process.uid is the agent, so revoking that would leave the
  // human in the access group and still able to spawn the disabled agent.
  const humanUid = ctx.identity ? resolveCallerOwnerUid(ctx) : undefined;
  if (typeof humanUid === "number" && (record.manifest.profiles?.length ?? 0) > 0) {
    revokePackageAgentAccess(ctx, record, humanUid);
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

  const scopes = visiblePackageScopesForContext(ctx);
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

function isRequiredSystemConsolePackage(record: InstalledPackageRecord): boolean {
  if (record.manifest.name === "packages") {
    return true;
  }
  return record.manifest.name === "gsv"
    && record.packageId.startsWith("builtin:gsv@")
    && record.manifest.source.repo === "root/gsv"
    && normalizeRepoPath(record.manifest.source.subdir) === "builtin-packages/gsv";
}

async function provisionEnabledPackageAgentsForCaller(
  ctx: KernelContext,
  record: InstalledPackageRecord,
): Promise<void> {
  await provisionEnabledPackagesForCaller(ctx, [record]);
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

function resolveCreateRepo(repo: string, fallbackOwner: string): RipgitRepoRef {
  const raw = typeof repo === "string" ? repo.trim().replace(/^\/+|\/+$/g, "") : "";
  const parts = raw.split("/").filter(Boolean);
  if (parts.length === 1) {
    return {
      owner: normalizeRepoOwner(fallbackOwner),
      repo: normalizeRepoName(parts[0]),
    };
  }
  if (parts.length === 2) {
    return {
      owner: normalizeRepoOwner(parts[0]),
      repo: normalizeRepoName(parts[1]),
    };
  }
  throw new Error("repo must be '<repo>' or '<owner>/<repo>'");
}

function normalizeRepoOwner(owner: string): string {
  const value = String(owner ?? "").trim();
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(`Invalid repo owner: ${owner}`);
  }
  return value;
}

function normalizeRepoName(name: string): string {
  const value = sanitizeRepoName(String(name ?? ""));
  if (!value) {
    throw new Error(`Invalid repo name: ${name}`);
  }
  return value;
}

function normalizePackageCreateRef(ref: string | undefined): string {
  const value = typeof ref === "string" && ref.trim().length > 0
    ? ref.trim()
    : DEFAULT_PACKAGE_CREATE_REF;
  if (!/^(refs\/heads\/)?[A-Za-z0-9._/-]+$/.test(value) || value.includes("..")) {
    throw new Error(`Invalid branch ref: ${value}`);
  }
  return value.startsWith("refs/heads/") ? value.slice("refs/heads/".length) : value;
}

function normalizePackageCreateTemplate(template: PkgCreateTemplate | undefined): PkgCreateTemplate {
  if (!template) {
    return "web-ui";
  }
  if (template !== "web-ui" && template !== "command") {
    throw new Error(`Unsupported package template: ${String(template)}`);
  }
  return template;
}

function packageCreateApplyOptions(
  ref: string,
  heads: Record<string, string> | undefined,
): { baseRef?: string } | undefined {
  if (heads?.[ref]) {
    return undefined;
  }

  if (heads?.[DEFAULT_PACKAGE_CREATE_REF]) {
    return { baseRef: DEFAULT_PACKAGE_CREATE_REF };
  }

  const fallback = Object.keys(heads ?? {}).sort()[0];
  return fallback ? { baseRef: fallback } : undefined;
}

function normalizePackageJsonName(rawName: string | undefined, repo: RipgitRepoRef): string {
  const fallback = `@${repo.owner.toLowerCase()}/${repo.repo.toLowerCase()}`;
  const value = typeof rawName === "string" && rawName.trim().length > 0
    ? rawName.trim().toLowerCase()
    : fallback;
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(value)) {
    throw new Error(`Invalid package name: ${value}`);
  }
  return value;
}

function normalizePackageDisplayName(rawName: string | undefined, repoName: string): string {
  const value = typeof rawName === "string" && rawName.trim().length > 0
    ? rawName.trim()
    : humanizeName(repoName);
  if (value.length > 80) {
    throw new Error("displayName must be 80 characters or fewer");
  }
  return value;
}

function normalizePackageDescription(rawDescription: string | undefined, displayName: string): string {
  const value = typeof rawDescription === "string" && rawDescription.trim().length > 0
    ? rawDescription.trim()
    : `${displayName} package.`;
  if (value.length > 240) {
    throw new Error("description must be 240 characters or fewer");
  }
  return value;
}

function normalizePackageCommandName(rawCommand: string | undefined, repoName: string): string {
  const value = typeof rawCommand === "string" && rawCommand.trim().length > 0
    ? rawCommand.trim().toLowerCase()
    : repoName.toLowerCase();
  const normalized = value.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(normalized)) {
    throw new Error(`Invalid command name: ${value}`);
  }
  return normalized;
}

function humanizeName(value: string): string {
  const words = value
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1));
  return words.length > 0 ? words.join(" ") : "New Package";
}

function buildPackageScaffold(input: {
  packageName: string;
  displayName: string;
  description: string;
  template: PkgCreateTemplate;
  command: string;
}): Record<string, string> {
  return input.template === "command"
    ? buildCommandPackageScaffold(input)
    : buildWebUiPackageScaffold(input);
}

function buildBasePackageJson(packageName: string): string {
  return `${JSON.stringify({
    name: packageName,
    version: "0.1.0",
    type: "module",
    dependencies: {
      "@humansandmachines/gsv": "0.0.1",
    },
  }, null, 2)}\n`;
}

function buildWebUiPackageScaffold(input: {
  packageName: string;
  displayName: string;
  description: string;
}): Record<string, string> {
  return {
    "package.json": buildBasePackageJson(input.packageName),
    "src/package.ts": [
      'import { definePackage } from "@humansandmachines/gsv/sdk";',
      "",
      "export default definePackage({",
      "  meta: {",
      `    displayName: ${JSON.stringify(input.displayName)},`,
      `    description: ${JSON.stringify(input.description)},`,
      "    window: {",
      "      width: 1040,",
      "      height: 720,",
      "      minWidth: 720,",
      "      minHeight: 480,",
      "    },",
      "  },",
      "  browser: {",
      '    entry: "./src/main.ts",',
      '    assets: ["./src/styles.css"],',
      "  },",
      "});",
      "",
    ].join("\n"),
    "src/main.ts": [
      'import { getAppBoot } from "@humansandmachines/gsv/sdk";',
      "",
      "const boot = getAppBoot();",
      'const root = document.createElement("main");',
      'root.className = "app-shell";',
      "root.innerHTML = `",
      '  <section class="app-panel">',
      `    <h1>${escapeHtml(input.displayName)}</h1>`,
      `    <p>${escapeHtml(input.description)}</p>`,
      '    <dl>',
      '      <div><dt>Package</dt><dd>${boot.packageName}</dd></div>',
      '      <div><dt>Route</dt><dd>${boot.routeBase}</dd></div>',
      '    </dl>',
      "  </section>",
      "`;",
      "document.body.replaceChildren(root);",
      "",
    ].join("\n"),
    "src/styles.css": [
      ":root {",
      "  color: #1f2933;",
      "  background: #f7f9fb;",
      '  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;',
      "}",
      "",
      "body {",
      "  margin: 0;",
      "}",
      "",
      ".app-shell {",
      "  min-height: 100vh;",
      "  display: grid;",
      "  place-items: center;",
      "  padding: 32px;",
      "}",
      "",
      ".app-panel {",
      "  width: min(720px, 100%);",
      "  border: 1px solid #d8e0e8;",
      "  border-radius: 8px;",
      "  background: #ffffff;",
      "  padding: 24px;",
      "  box-shadow: 0 12px 32px rgba(31, 41, 51, 0.08);",
      "}",
      "",
      "h1 {",
      "  margin: 0 0 8px;",
      "  font-size: 24px;",
      "  line-height: 1.2;",
      "}",
      "",
      "p {",
      "  margin: 0 0 20px;",
      "  color: #52606d;",
      "}",
      "",
      "dl {",
      "  display: grid;",
      "  gap: 8px;",
      "  margin: 0;",
      "}",
      "",
      "dl > div {",
      "  display: flex;",
      "  justify-content: space-between;",
      "  gap: 16px;",
      "}",
      "",
      "dt {",
      "  color: #627d98;",
      "}",
      "",
      "dd {",
      "  margin: 0;",
      "  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;",
      "}",
      "",
    ].join("\n"),
    "README.md": [
      `# ${input.displayName}`,
      "",
      input.description,
      "",
      "This package was scaffolded by GSV. Edit `src/main.ts`, `src/styles.css`, and `src/package.ts`, then run `pkg source commit --message \"...\"` and `pkg checkout <branch>` when you want to install committed source changes.",
      "",
    ].join("\n"),
  };
}

function buildCommandPackageScaffold(input: {
  packageName: string;
  displayName: string;
  description: string;
  command: string;
}): Record<string, string> {
  const commandPath = `src/cli/${input.command}.ts`;
  return {
    "package.json": buildBasePackageJson(input.packageName),
    "src/package.ts": [
      'import { definePackage } from "@humansandmachines/gsv/sdk";',
      "",
      "export default definePackage({",
      "  meta: {",
      `    displayName: ${JSON.stringify(input.displayName)},`,
      `    description: ${JSON.stringify(input.description)},`,
      "  },",
      "  cli: {",
      "    commands: {",
      `      ${JSON.stringify(input.command)}: ${JSON.stringify(`./${commandPath}`)},`,
      "    },",
      "  },",
      "});",
      "",
    ].join("\n"),
    [commandPath]: [
      'import { defineCommand } from "@humansandmachines/gsv/sdk";',
      "",
      "export default defineCommand(async (ctx) => {",
      '  const subject = ctx.argv.length > 0 ? ctx.argv.join(" ") : ctx.meta.packageName;',
      `  await ctx.stdout.write(\`Hello from \${ctx.meta.packageName}: \${subject}\\n\`);`,
      "});",
      "",
    ].join("\n"),
    "README.md": [
      `# ${input.displayName}`,
      "",
      input.description,
      "",
      `Run this package with \`${input.command} ...\` after enabling it.`,
      "",
    ].join("\n"),
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function joinPackageSourcePath(subdir: string, path: string): string {
  const normalizedSubdir = normalizeRepoPath(subdir) || ".";
  const normalizedPath = normalizeRepoPath(path);
  if (!normalizedPath) {
    throw new Error("path is required");
  }
  return normalizedSubdir === "." ? normalizedPath : `${normalizedSubdir}/${normalizedPath}`;
}

async function inspectPackageCreateTarget(
  ripgit: RipgitClient,
  repo: RipgitRepoRef,
  subdir: string,
): Promise<{
  kind: "missing" | "file" | "tree";
  hasPackageJson: boolean;
  nonEmpty: boolean;
}> {
  const target = await ripgit.readPath(repo, normalizeRepoPath(subdir) || ".");
  if (target.kind === "missing") {
    return { kind: "missing", hasPackageJson: false, nonEmpty: false };
  }
  if (target.kind === "file") {
    return { kind: "file", hasPackageJson: false, nonEmpty: true };
  }

  const entries = target.entries.filter((entry) => entry.name !== ".dir");
  return {
    kind: "tree",
    hasPackageJson: entries.some((entry) => entry.name === "package.json"),
    nonEmpty: entries.length > 0,
  };
}

function repoSlug(repo: Pick<RipgitRepoRef, "owner" | "repo">): string {
  return `${repo.owner}/${repo.repo}`;
}

function registerPackageRepo(
  ctx: KernelContext,
  repo: Pick<RipgitRepoRef, "owner" | "repo">,
  description?: string,
): void {
  const now = String(Date.now());
  const createdKey = packageRepoConfigKey(repo, "created_at");
  if (ctx.config.get(createdKey) === null) {
    ctx.config.set(createdKey, now);
  }
  ctx.config.set(packageRepoConfigKey(repo, "updated_at"), now);
  if (typeof description === "string" && description.trim().length > 0) {
    ctx.config.set(packageRepoConfigKey(repo, "description"), description.trim());
  }
}

function packageRepoConfigKey(repo: Pick<RipgitRepoRef, "owner" | "repo">, field: string): string {
  return `repos/${repo.owner}/${repo.repo}/${field}`;
}

function packageIdForSource(manifest: PackageManifest): string {
  const source = manifest.source;
  return `import:${source.repo}:${normalizeRepoPath(source.subdir) || "."}`;
}

function grantsForManifest(manifest: PackageManifest): PackageGrantSet {
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
  return defaultPackageInstallScopeForActor(packageScopeOwnerForContext(ctx));
}

function assertMutablePackageAccess(record: InstalledPackageRecord, ctx: KernelContext): void {
  const identity = requireIdentity(ctx);
  if (identity.process.uid === 0 || (identity.capabilities ?? []).includes("*")) {
    return;
  }
  if (packageScopeEquals(record.scope, { kind: "user", uid: resolveCallerOwnerUid(ctx) })) {
    return;
  }
  throw new Error(`Forbidden: ${record.packageId} is not installed in your package scope`);
}

function visiblePackageScopesForContext(ctx: KernelContext): PackageInstallScope[] {
  return visiblePackageScopesForActor(packageScopeOwnerForContext(ctx));
}

function packageScopeOwnerForContext(ctx: KernelContext): { uid: number } | undefined {
  return ctx.identity ? { uid: resolveCallerOwnerUid(ctx) } : undefined;
}

function remoteConfigOwnerUid(ctx: KernelContext): number {
  requireIdentity(ctx);
  return resolveCallerOwnerUid(ctx);
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
    profiles: (record.manifest.profiles ?? []).map((profile) => ({
      name: profile.name,
      displayName: profile.displayName,
      description: profile.description,
      icon: profile.icon,
      capabilities: profile.capabilities,
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
    profiles: (record.manifest.profiles ?? []).map((profile) => ({
      name: profile.name,
      displayName: profile.displayName,
      description: profile.description,
      icon: profile.icon,
      capabilities: profile.capabilities,
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
    profiles: Array.isArray(value.profiles) ? value.profiles as PkgCatalogEntry["profiles"] : [],
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
