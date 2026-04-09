import type { KernelContext } from "../context";
import type { SysBootstrapArgs, SysBootstrapResult } from "../../syscalls/system";
import { RipgitClient, type RipgitRepoRef } from "../../fs/ripgit/client";
import {
  buildBuiltinPackageSeeds,
  type PackageEntrypoint,
  type PackageRuntime,
} from "../packages";

const DEFAULT_GSV_UPSTREAM_URL = "https://github.com/deathbyknowledge/gsv";
const DEFAULT_GSV_UPSTREAM_REF = "osify";
const SYSTEM_GSV_REPO: RipgitRepoRef = {
  owner: "system",
  repo: "gsv",
  branch: "main",
};

export async function handleSysBootstrap(
  args: SysBootstrapArgs | undefined,
  ctx: KernelContext,
): Promise<SysBootstrapResult> {
  if (!ctx.env.RIPGIT) {
    throw new Error("RIPGIT binding is required for system bootstrap");
  }

  const remoteUrl =
    typeof args?.remoteUrl === "string" && args.remoteUrl.trim().length > 0
      ? args.remoteUrl.trim()
      : typeof args?.repo === "string" && args.repo.trim().length > 0
        ? githubRepoUrl(args.repo.trim())
      : DEFAULT_GSV_UPSTREAM_URL;
  const ref =
    typeof args?.ref === "string" && args.ref.trim().length > 0
      ? args.ref.trim()
      : DEFAULT_GSV_UPSTREAM_REF;

  const ripgit = new RipgitClient(ctx.env.RIPGIT, ctx.env.RIPGIT_INTERNAL_KEY ?? null);
  if (!ctx.identity) {
    throw new Error("Authenticated identity required");
  }
  const actorName = ctx.identity.process.username;
  const imported = await ripgit.importFromUpstream(
    SYSTEM_GSV_REPO,
    actorName,
    `${actorName}@gsv.local`,
    `bootstrap system/gsv from ${remoteUrl}#${ref}`,
    remoteUrl,
    ref,
  );

  const builtinSeeds = await buildBuiltinPackageSeeds(ctx.env);
  const installed = ctx.packages.seedBuiltinPackages(builtinSeeds);

  return {
    repo: "system/gsv",
    remoteUrl: imported.remoteUrl,
    ref: imported.remoteRef,
    head: imported.head ?? null,
    changed: imported.changed,
    packages: installed.map((record) => ({
      packageId: record.packageId,
      name: record.manifest.name,
      description: record.manifest.description,
      version: record.manifest.version,
      runtime: toSysBootstrapRuntime(record.manifest.runtime),
      enabled: record.enabled,
      source: {
        repo: record.manifest.source.repo,
        ref: record.manifest.source.ref,
        subdir: record.manifest.source.subdir,
        resolvedCommit: record.manifest.source.resolvedCommit ?? null,
      },
      entrypoints: record.manifest.entrypoints.flatMap(toSysBootstrapEntrypoint),
    })),
  };
}

function toSysBootstrapRuntime(runtime: PackageRuntime): SysBootstrapResult["packages"][number]["runtime"] {
  return runtime === "node" ? "node" : runtime;
}

function toSysBootstrapEntrypoint(
  entrypoint: PackageEntrypoint,
): SysBootstrapResult["packages"][number]["entrypoints"] {
  if (entrypoint.kind !== "command" && entrypoint.kind !== "task" && entrypoint.kind !== "ui") {
    return [];
  }
  return [{
    name: entrypoint.name,
    kind: entrypoint.kind,
    description: entrypoint.description,
    command: entrypoint.command,
    route: entrypoint.route,
    icon: entrypoint.icon?.kind === "builtin" ? entrypoint.icon.id : undefined,
    syscalls: entrypoint.syscalls,
    windowDefaults: entrypoint.windowDefaults,
  }];
}

function githubRepoUrl(repo: string): string {
  const trimmed = repo.replace(/^\/+|\/+$/g, "");
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(trimmed)) {
    throw new Error(`Invalid bootstrap repo: ${repo}`);
  }
  return `https://github.com/${trimmed}`;
}
