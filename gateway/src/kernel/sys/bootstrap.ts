import type { KernelContext } from "../context";
import type { SysBootstrapArgs, SysBootstrapResult } from "@gsv/protocol/syscalls/system";
import { RipgitClient, type RipgitRepoRef } from "../../fs/ripgit/client";
import {
  CLI_BINARY_ASSETS,
  CLI_RELEASE_CHANNELS,
  inferDefaultCliChannel,
  mirrorCliChannel,
  storeDefaultCliChannel,
} from "../../downloads/cli";
import {
  buildBuiltinPackageSeeds,
  type PackageEntrypoint,
  type PackageRuntime,
} from "../packages";

const DEFAULT_GSV_UPSTREAM_URL = "https://github.com/deathbyknowledge/gsv";
const DEFAULT_GSV_UPSTREAM_REF = "main";
const SYSTEM_GSV_REPO: RipgitRepoRef = {
  owner: "system",
  repo: "gsv",
  branch: "main",
};

type BootstrapTiming = {
  label: string;
  ms: number;
};

async function timeBootstrapStep<T>(
  timings: BootstrapTiming[],
  label: string,
  run: () => T | Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  try {
    return await run();
  } finally {
    timings.push({ label, ms: Date.now() - startedAt });
  }
}

function formatBootstrapTimings(timings: BootstrapTiming[]): string {
  if (timings.length === 0) {
    return "no steps completed";
  }
  return timings.map((timing) => `${timing.label}=${timing.ms}ms`).join(", ");
}

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

  const ripgit = new RipgitClient(ctx.env.RIPGIT);
  if (!ctx.identity) {
    throw new Error("Authenticated identity required");
  }
  const actorName = ctx.identity.process.username;
  const startedAt = Date.now();
  const timings: BootstrapTiming[] = [];

  try {
    const imported = await timeBootstrapStep(timings, "import-upstream", () => ripgit.importFromUpstream(
      SYSTEM_GSV_REPO,
      actorName,
      `${actorName}@gsv.local`,
      `bootstrap system/gsv from ${remoteUrl}#${ref}`,
      remoteUrl,
      ref,
    ));

    const builtinSeeds = await timeBootstrapStep(
      timings,
      "resolve-builtin-seeds",
      () => buildBuiltinPackageSeeds(ctx.env),
    );
    const installed = await timeBootstrapStep(
      timings,
      "seed-builtin-packages",
      () => ctx.packages.seedBuiltinPackages(builtinSeeds),
    );
    const defaultCliChannel = inferDefaultCliChannel(imported.remoteRef);
    const mirroredChannels: Array<"stable" | "dev"> = [];
    if (!ctx.env.STORAGE) {
      throw new Error("STORAGE binding is required for CLI bootstrap");
    }
    for (const channel of CLI_RELEASE_CHANNELS) {
      await timeBootstrapStep(timings, `mirror-cli:${channel}`, () => mirrorCliChannel(ctx.env.STORAGE, channel));
      mirroredChannels.push(channel);
    }
    await timeBootstrapStep(
      timings,
      "store-default-cli-channel",
      () => storeDefaultCliChannel(ctx.env.STORAGE, defaultCliChannel),
    );

    console.info(
      `[sys.bootstrap] ${remoteUrl}#${ref} completed in ${Date.now() - startedAt}ms (${formatBootstrapTimings(timings)})`,
    );

    return {
      repo: "system/gsv",
      remoteUrl: imported.remoteUrl,
      ref: imported.remoteRef,
      head: imported.head ?? null,
      changed: imported.changed,
      cli: {
        defaultChannel: defaultCliChannel,
        mirroredChannels,
        assets: [...CLI_BINARY_ASSETS],
      },
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[sys.bootstrap] ${remoteUrl}#${ref} failed after ${Date.now() - startedAt}ms (${formatBootstrapTimings(timings)}): ${message}`,
    );
    throw error;
  }
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
