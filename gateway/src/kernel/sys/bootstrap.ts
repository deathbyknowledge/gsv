import type { KernelContext } from "../context";
import type { SysBootstrapArgs, SysBootstrapResult } from "@gsv/protocol/syscalls/system";
import { RipgitClient, type RipgitRepoRef } from "../../fs/ripgit/client";
import {
  CLI_BINARY_ASSETS,
  CLI_RELEASE_CHANNELS,
  inferDefaultCliChannel,
  mirrorCliChannel,
  storeCliInstallScripts,
  storeDefaultCliChannel,
} from "../../downloads/cli";
import { seedPiperPublicAssets } from "../../downloads/piper-assets";
import {
  buildBuiltinPackageSeeds,
  type PackageEntrypoint,
  type PackageRuntime,
} from "../packages";
import { provisionEnabledPackagesForCaller } from "../package-agents";
import { seedRepoSkillsToHome } from "./skills-seed";
import { seedRepoKnowledgeToHome } from "./knowledge-seed";

const DEFAULT_GSV_UPSTREAM_URL = "https://github.com/deathbyknowledge/gsv";
const DEFAULT_GSV_UPSTREAM_REF = "main";
const GSV_BOOTSTRAP_UPSTREAM_ENV = "GSV_BOOTSTRAP_UPSTREAM";
const GSV_BOOTSTRAP_REF_ENV = "GSV_BOOTSTRAP_REF";
const BOOTSTRAP_OUTBOUND_SLOTS = 5;
const BOOTSTRAP_PACKAGE_SLOTS = 2;
const ROOT_GSV_REPO: RipgitRepoRef = {
  owner: "root",
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

async function allSettledOrThrow<T extends readonly unknown[]>(
  promises: { [K in keyof T]: Promise<T[K]> },
): Promise<T> {
  const results = await Promise.allSettled(promises);
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (rejected) {
    throw rejected.reason;
  }
  return results.map((result) => (result as PromiseFulfilledResult<unknown>).value) as unknown as T;
}

function createBootstrapLimiter(maxSlots: number) {
  type QueuedTask<T> = {
    slots: number;
    run: () => T | Promise<T>;
    resolve: (value: T) => void;
    reject: (error: unknown) => void;
  };

  const queue: Array<QueuedTask<unknown>> = [];
  let activeSlots = 0;
  const capacity = Math.max(1, Math.floor(maxSlots));

  function pump(): void {
    for (;;) {
      const index = queue.findIndex((task) => activeSlots + task.slots <= capacity);
      if (index === -1) {
        return;
      }

      const [task] = queue.splice(index, 1);
      activeSlots += task.slots;
      Promise.resolve()
        .then(task.run)
        .then(task.resolve, task.reject)
        .finally(() => {
          activeSlots -= task.slots;
          pump();
        });
    }
  }

  return async function limitBootstrap<T>(
    slots: number,
    run: () => T | Promise<T>,
  ): Promise<T> {
    const taskSlots = Math.max(1, Math.min(capacity, Math.floor(slots)));
    return new Promise<T>((resolve, reject) => {
      queue.push({
        slots: taskSlots,
        run,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      pump();
    });
  };
}

export async function handleSysBootstrap(
  args: SysBootstrapArgs | undefined,
  ctx: KernelContext,
): Promise<SysBootstrapResult> {
  if (!ctx.env.RIPGIT) {
    throw new Error("RIPGIT binding is required for system bootstrap");
  }

  const { remoteUrl, ref } = resolveBootstrapUpstream(args, ctx.env);

  const ripgit = new RipgitClient(ctx.env.RIPGIT);
  if (!ctx.identity) {
    throw new Error("Authenticated identity required");
  }
  const actorName = ctx.identity.process.username;
  const startedAt = Date.now();
  const timings: BootstrapTiming[] = [];

  try {
    const imported = await timeBootstrapStep(timings, "import-upstream", () => ripgit.importFromUpstream(
      ROOT_GSV_REPO,
      actorName,
      `${actorName}@gsv.local`,
      `bootstrap root/gsv from ${remoteUrl}#${ref}`,
      remoteUrl,
      ref,
    ));
    const defaultCliChannel = inferDefaultCliChannel(imported.remoteRef);
    if (!ctx.env.STORAGE) {
      throw new Error("STORAGE binding is required for CLI bootstrap");
    }
    const storage = ctx.env.STORAGE;
    const importedRepo = {
      ...ROOT_GSV_REPO,
      branch: imported.head ?? imported.remoteRef,
    };
    const limitBootstrap = createBootstrapLimiter(BOOTSTRAP_OUTBOUND_SLOTS);

    const seedSkillsPromise = limitBootstrap(1, () =>
      timeBootstrapStep(timings, "seed-skills", () => seedRepoSkillsToHome(
        ripgit,
        importedRepo,
        ctx.identity!.process,
      ))
    );
    const seedKnowledgePromise = timeBootstrapStep(
      timings,
      "seed-knowledge",
      () => seedRepoKnowledgeToHome(
        ripgit,
        importedRepo,
        ctx.identity!.process,
        {
          concurrency: BOOTSTRAP_OUTBOUND_SLOTS,
          schedule: (run) => limitBootstrap(1, run),
        },
      ),
    );

    const installPackagesPromise = limitBootstrap(BOOTSTRAP_PACKAGE_SLOTS, async () => {
      const builtinSeeds = await timeBootstrapStep(
        timings,
        "resolve-builtin-seeds",
        () => buildBuiltinPackageSeeds(ctx.env),
      );
      return await timeBootstrapStep(
        timings,
        "seed-builtin-packages",
        async () => {
          const installed = await ctx.packages.seedBuiltinPackages(builtinSeeds);
          await provisionEnabledPackagesForCaller(ctx, installed);
          return installed;
        },
      );
    });

    const mirrorCliPromise = (async () => {
      const mirroredChannels = await allSettledOrThrow(CLI_RELEASE_CHANNELS.map(async (channel) => {
        await limitBootstrap(
          1,
          () => timeBootstrapStep(timings, `mirror-cli:${channel}`, () => mirrorCliChannel(storage, channel)),
        );
        return channel;
      }));
      await allSettledOrThrow([
        limitBootstrap(
          1,
          () => timeBootstrapStep(
            timings,
            "store-default-cli-channel",
            () => storeDefaultCliChannel(storage, defaultCliChannel),
          ),
        ),
        limitBootstrap(
          1,
          () => timeBootstrapStep(
            timings,
            "store-cli-install-scripts",
            () => storeCliInstallScripts(storage),
          ),
        ),
      ]);
      return mirroredChannels;
    })();

    const seedPiperPromise = limitBootstrap(
      1,
      () => timeBootstrapStep(
        timings,
        "seed-piper-assets",
        () => seedPiperPublicAssets(storage),
      ),
    );

    const [, , installed, mirroredChannels] = await allSettledOrThrow([
      seedSkillsPromise,
      seedKnowledgePromise,
      installPackagesPromise,
      mirrorCliPromise,
      seedPiperPromise,
    ]);

    console.info(
      `[sys.bootstrap] ${remoteUrl}#${ref} completed in ${Date.now() - startedAt}ms (${formatBootstrapTimings(timings)})`,
    );

    return {
      repo: "root/gsv",
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
  if (entrypoint.kind !== "command" && entrypoint.kind !== "ui") {
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

function resolveBootstrapUpstream(
  args: SysBootstrapArgs | undefined,
  env: Env,
): { remoteUrl: string; ref: string } {
  const explicitRemoteUrl = readNonEmptyString(args?.remoteUrl);
  const explicitRepo = readNonEmptyString(args?.repo);
  const configuredUpstream = readEnvString(env, GSV_BOOTSTRAP_UPSTREAM_ENV);
  const configured = configuredUpstream ? parseConfiguredUpstream(configuredUpstream) : undefined;
  const remoteUrl = explicitRemoteUrl
    ?? (explicitRepo ? githubRepoUrl(explicitRepo) : undefined)
    ?? configured?.remoteUrl
    ?? DEFAULT_GSV_UPSTREAM_URL;
  const ref = readNonEmptyString(args?.ref)
    ?? readEnvString(env, GSV_BOOTSTRAP_REF_ENV)
    ?? configured?.ref
    ?? DEFAULT_GSV_UPSTREAM_REF;

  return { remoteUrl, ref };
}

function parseConfiguredUpstream(value: string): { remoteUrl: string; ref?: string } {
  const split = splitUpstreamRef(value);
  return {
    remoteUrl: bootstrapUpstreamUrl(split.upstream),
    ref: split.ref,
  };
}

function splitUpstreamRef(value: string): { upstream: string; ref?: string } {
  const hashIndex = value.lastIndexOf("#");
  if (hashIndex <= 0 || hashIndex === value.length - 1) {
    return { upstream: value };
  }
  const upstream = value.slice(0, hashIndex).trim();
  const ref = value.slice(hashIndex + 1).trim();
  if (!upstream || !ref) {
    return { upstream: value };
  }
  return { upstream, ref };
}

function bootstrapUpstreamUrl(value: string): string {
  if (looksLikeGitRemoteUrl(value)) {
    return value;
  }
  return githubRepoUrl(value);
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readEnvString(env: Env, name: string): string | undefined {
  return readNonEmptyString((env as unknown as Record<string, unknown>)[name]);
}

function looksLikeGitRemoteUrl(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value) || /^[^@]+@[^:]+:.+$/.test(value);
}
