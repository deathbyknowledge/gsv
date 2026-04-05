import type { KernelContext } from "./context";
import type {
  PkgCheckoutArgs,
  PkgCheckoutResult,
  PkgInstallArgs,
  PkgInstallResult,
  PkgListArgs,
  PkgListResult,
  PkgSyncArgs,
  PkgSyncResult,
  PkgRepoLogArgs,
  PkgRepoLogResult,
  PkgRepoReadArgs,
  PkgRepoReadResult,
  PkgRepoRefsArgs,
  PkgRepoRefsResult,
  PkgRemoveArgs,
  PkgRemoveResult,
  PkgSummary,
} from "../syscalls/packages";
import type {
  InstalledPackageRecord,
  PackageArtifact,
  PackageEntrypoint,
} from "./packages";
import { buildBuiltinPackageSeeds, resolvePackageFromRipgitSource } from "./packages";
import { RipgitClient, type RipgitRepoRef } from "../fs/ripgit/client";

const TEXT_DECODER = new TextDecoder();
const STRICT_TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });

export function handlePkgList(
  args: PkgListArgs | undefined,
  ctx: KernelContext,
): PkgListResult {
  return {
    packages: ctx.packages.list({
      enabled: typeof args?.enabled === "boolean" ? args.enabled : undefined,
      name: typeof args?.name === "string" && args.name.trim().length > 0 ? args.name.trim() : undefined,
      runtime: args?.runtime,
    }).map(toPkgSummary),
  };
}

export function handlePkgInstall(
  args: PkgInstallArgs,
  ctx: KernelContext,
): PkgInstallResult {
  const record = requirePackage(args.packageId, ctx);
  if (!record.enabled) {
    const updated = ctx.packages.setEnabled(record.packageId, true);
    if (!updated) {
      throw new Error(`Failed to enable package: ${record.packageId}`);
    }
  }

  return {
    changed: !record.enabled,
    package: toPkgSummary(requirePackage(record.packageId, ctx)),
  };
}

export async function handlePkgSync(
  _args: PkgSyncArgs | undefined,
  ctx: KernelContext,
): Promise<PkgSyncResult> {
  const builtinSeeds = await buildBuiltinPackageSeeds(ctx.env);
  const installed = ctx.packages.seedBuiltinPackages(builtinSeeds);
  return {
    packages: installed.map(toPkgSummary),
  };
}

export async function handlePkgCheckout(
  args: PkgCheckoutArgs,
  ctx: KernelContext,
): Promise<PkgCheckoutResult> {
  const record = requirePackage(args.packageId, ctx);
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

  const updated = ctx.packages.install({
    packageId: record.packageId,
    manifest: resolved.manifest,
    artifact: resolved.artifact,
    grants: record.grants,
    enabled: record.enabled,
    installedAt: record.installedAt,
    updatedAt: Date.now(),
  });

  return {
    changed:
      record.manifest.source.ref !== ref ||
      (record.manifest.source.resolvedCommit ?? null) !== (updated.manifest.source.resolvedCommit ?? null) ||
      record.artifact.hash !== updated.artifact.hash,
    package: toPkgSummary(updated),
  };
}

export function handlePkgRemove(
  args: PkgRemoveArgs,
  ctx: KernelContext,
): PkgRemoveResult {
  const record = requirePackage(args.packageId, ctx);
  if (record.manifest.name === "packages") {
    throw new Error("Cannot remove the packages manager");
  }
  if (record.enabled) {
    const updated = ctx.packages.setEnabled(record.packageId, false);
    if (!updated) {
      throw new Error(`Failed to disable package: ${record.packageId}`);
    }
  }

  return {
    changed: record.enabled,
    package: toPkgSummary(requirePackage(record.packageId, ctx)),
  };
}

export async function handlePkgRepoRefs(
  args: PkgRepoRefsArgs,
  ctx: KernelContext,
): Promise<PkgRepoRefsResult> {
  const { record, repo } = resolvePackageRepoRef(args.packageId, undefined, ctx);
  const ripgit = requireRipgitClient(ctx);
  const refs = await ripgit.refs(repo);
  return {
    packageId: record.packageId,
    repo: record.manifest.source.repo,
    activeRef: record.manifest.source.ref,
    heads: refs.heads ?? {},
    tags: refs.tags ?? {},
  };
}

export async function handlePkgRepoRead(
  args: PkgRepoReadArgs,
  ctx: KernelContext,
): Promise<PkgRepoReadResult> {
  const { record, repo, ref } = resolvePackageRepoRef(args.packageId, args.ref, ctx);
  const ripgit = requireRipgitClient(ctx);
  const path = normalizeRepoPath(args.path);
  const root = normalizeRepoPath(record.manifest.source.subdir);
  const result = await ripgit.readPath(repo, joinRepoPath(root, path));

  if (result.kind === "missing") {
    throw new Error(`Path not found: ${path || "/"}`);
  }

  if (result.kind === "tree") {
    return {
      packageId: record.packageId,
      repo: record.manifest.source.repo,
      ref,
      path,
      kind: "tree",
      entries: result.entries.map((entry) => ({
        name: entry.name,
        path: path ? `${path}/${entry.name}` : entry.name,
        mode: entry.mode,
        hash: entry.hash,
        type: entry.type,
      })),
    };
  }

  return {
    packageId: record.packageId,
    repo: record.manifest.source.repo,
    ref,
    path,
    kind: "file",
    size: result.size,
    isBinary: isBinaryBytes(result.bytes),
    content: decodeRepoFile(result.bytes),
  };
}

export async function handlePkgRepoLog(
  args: PkgRepoLogArgs,
  ctx: KernelContext,
): Promise<PkgRepoLogResult> {
  const { record, repo, ref } = resolvePackageRepoRef(args.packageId, args.ref, ctx);
  const ripgit = requireRipgitClient(ctx);
  const limit = clampRepoLimit(args.limit);
  const offset = clampRepoOffset(args.offset);
  const entries = await ripgit.log(repo, { limit, offset });

  return {
    packageId: record.packageId,
    repo: record.manifest.source.repo,
    ref,
    limit,
    offset,
    entries: entries.map((entry) => ({
      hash: entry.hash,
      treeHash: entry.tree_hash,
      author: entry.author,
      authorEmail: entry.author_email,
      authorTime: entry.author_time,
      committer: entry.committer,
      committerEmail: entry.committer_email,
      commitTime: entry.commit_time,
      message: entry.message,
      parents: Array.isArray(entry.parents) ? entry.parents : [],
    })),
  };
}

function requirePackage(packageId: string, ctx: KernelContext): InstalledPackageRecord {
  const normalizedPackageId = typeof packageId === "string" ? packageId.trim() : "";
  if (!normalizedPackageId) {
    throw new Error("packageId is required");
  }

  const record = ctx.packages.get(normalizedPackageId);
  if (!record) {
    throw new Error(`Unknown package: ${normalizedPackageId}`);
  }
  return record;
}

function toPkgSummary(record: InstalledPackageRecord): PkgSummary {
  return {
    packageId: record.packageId,
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
    },
    entrypoints: record.manifest.entrypoints.map((entrypoint) => ({
      name: entrypoint.name,
      kind: entrypoint.kind,
      description: entrypoint.description,
      command: entrypoint.command,
      route: entrypoint.route,
      icon: resolveEntrypointIcon(entrypoint, record.artifact),
      syscalls: entrypoint.syscalls,
      windowDefaults: entrypoint.windowDefaults,
    })),
    bindingNames: (record.manifest.capabilities?.bindings ?? []).map((binding) => binding.binding),
    installedAt: record.installedAt,
    updatedAt: record.updatedAt,
  };
}

function resolveEntrypointIcon(
  entrypoint: PackageEntrypoint,
  artifact: PackageArtifact,
): { kind: "builtin"; id: string } | { kind: "svg"; svg: string } | undefined {
  const icon = entrypoint.icon;
  if (!icon) {
    return undefined;
  }

  if (icon.kind === "builtin") {
    return { kind: "builtin", id: icon.id };
  }

  const module = artifact.modules.find((item) => item.path === icon.module);
  if (!module || module.content.trim().length === 0) {
    return undefined;
  }

  return {
    kind: "svg",
    svg: module.content,
  };
}

function requireRipgitClient(ctx: KernelContext): RipgitClient {
  const ripgitBinding = ctx.env.RIPGIT;
  if (!ripgitBinding) {
    throw new Error("RIPGIT binding is required");
  }
  return new RipgitClient(ripgitBinding, ctx.env.RIPGIT_INTERNAL_KEY ?? null);
}

function resolvePackageRepoRef(
  packageId: string,
  maybeRef: string | undefined,
  ctx: KernelContext,
): { record: InstalledPackageRecord; repo: RipgitRepoRef; ref: string } {
  const record = requirePackage(packageId, ctx);
  const repoRef = parseSyncRepoRef(record.manifest.source.repo);
  const ref = typeof maybeRef === "string" && maybeRef.trim().length > 0
    ? maybeRef.trim()
    : record.manifest.source.ref;
  return {
    record,
    repo: {
      owner: repoRef.owner,
      repo: repoRef.repo,
      branch: ref,
    },
    ref,
  };
}

function normalizeRepoPath(path: string | undefined): string {
  const trimmed = typeof path === "string" ? path.trim() : "";
  return trimmed.replace(/^\/+/, "").replace(/\/+$/, "");
}

function joinRepoPath(base: string, child: string): string {
  if (!base) return child;
  if (!child) return base;
  return `${base}/${child}`;
}

function clampRepoLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return 30;
  }
  return Math.max(1, Math.min(100, Math.trunc(limit)));
}

function clampRepoOffset(offset: number | undefined): number {
  if (typeof offset !== "number" || !Number.isFinite(offset)) {
    return 0;
  }
  return Math.max(0, Math.trunc(offset));
}

function isBinaryBytes(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 8192);
  for (let index = 0; index < limit; index += 1) {
    if (bytes[index] === 0) {
      return true;
    }
  }
  return false;
}

function decodeRepoFile(bytes: Uint8Array): string | null {
  if (isBinaryBytes(bytes)) {
    return null;
  }
  try {
    return STRICT_TEXT_DECODER.decode(bytes);
  } catch {
    return TEXT_DECODER.decode(bytes);
  }
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
