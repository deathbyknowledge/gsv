import type { KernelContext } from "./context";
import type {
  PkgCheckoutArgs,
  PkgCheckoutResult,
  PkgInstallArgs,
  PkgInstallResult,
  PkgListArgs,
  PkgListResult,
  PkgRemoveArgs,
  PkgRemoveResult,
  PkgSummary,
} from "../syscalls/packages";
import type {
  InstalledPackageRecord,
  PackageArtifact,
  PackageEntrypoint,
} from "./packages";
import { resolvePackageFromRipgitSource } from "./packages";

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
    changed: record.manifest.source.ref !== ref || record.artifact.hash !== updated.artifact.hash,
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
