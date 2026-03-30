import type { KernelContext } from "./context";
import type {
  PkgListArgs,
  PkgListResult,
  PkgSummary,
} from "../syscalls/packages";
import type { PackageArtifact, PackageEntrypoint } from "./packages";

export function handlePkgList(
  args: PkgListArgs | undefined,
  ctx: KernelContext,
): PkgListResult {
  const packages = ctx.packages.list({
    enabled: typeof args?.enabled === "boolean" ? args.enabled : undefined,
    name: typeof args?.name === "string" && args.name.trim().length > 0 ? args.name.trim() : undefined,
    runtime: args?.runtime,
  }).map<PkgSummary>((record) => ({
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
  }));

  return { packages };
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
