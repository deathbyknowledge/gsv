import type { KernelContext } from "../context";
import type { SysBootstrapArgs, SysBootstrapResult } from "@humansandmachines/gsv/protocol";
import { RipgitClient, type RipgitRepoRef } from "../../fs/ripgit/client";
import { inferDefaultCliChannel } from "../../downloads/cli";
import { seedRepoSkillsToHome } from "./skills-seed";
import { setRepoVisibility } from "../repo-visibility";
import { allSettledOrThrow, refreshCliDownloads } from "./update";

const DEFAULT_GSV_UPSTREAM_URL = "https://github.com/deathbyknowledge/gsv";
const DEFAULT_GSV_UPSTREAM_REF = "main";
const DEFAULT_GSV_MANUAL_UPSTREAM_URL = "https://github.com/deathbyknowledge/gsv-manual";
const DEFAULT_GSV_MANUAL_UPSTREAM_REF = "main";
const GSV_BOOTSTRAP_UPSTREAM_ENV = "GSV_BOOTSTRAP_UPSTREAM";
const GSV_BOOTSTRAP_REF_ENV = "GSV_BOOTSTRAP_REF";
const GSV_MANUAL_BOOTSTRAP_UPSTREAM_ENV = "GSV_MANUAL_BOOTSTRAP_UPSTREAM";
const GSV_MANUAL_BOOTSTRAP_REF_ENV = "GSV_MANUAL_BOOTSTRAP_REF";
const BOOTSTRAP_OUTBOUND_SLOTS = 5;
const ROOT_GSV_REPO: RipgitRepoRef = {
  owner: "root",
  repo: "gsv",
  branch: "main",
};
const ROOT_GSV_MANUAL_REPO: RipgitRepoRef = {
  owner: "root",
  repo: "gsv-manual",
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
  const { remoteUrl: manualRemoteUrl, ref: manualRef } = resolveManualBootstrapUpstream(ctx.env);

  const ripgit = new RipgitClient(ctx.env.RIPGIT);
  if (!ctx.identity) {
    throw new Error("Authenticated identity required");
  }
  const actorName = ctx.identity.process.username;
  const startedAt = Date.now();
  const timings: BootstrapTiming[] = [];

  try {
    const limitBootstrap = createBootstrapLimiter(BOOTSTRAP_OUTBOUND_SLOTS);
    const rootImportPromise = limitBootstrap(1, async () => {
      const importedRoot = await timeBootstrapStep(timings, "import-root-gsv", () => ripgit.importFromUpstream(
        ROOT_GSV_REPO,
        actorName,
        `${actorName}@gsv.local`,
        `bootstrap root/gsv from ${remoteUrl}#${ref}`,
        remoteUrl,
        ref,
      ));
      registerBootstrapRepo(ctx, ROOT_GSV_REPO, "GSV System Source");
      setPublicRepo(ctx, ROOT_GSV_REPO);
      return importedRoot;
    });
    const manualImportPromise = limitBootstrap(1, async () => {
      const importedManual = await timeBootstrapStep(timings, "import-gsv-manual", () => ripgit.importFromUpstream(
        ROOT_GSV_MANUAL_REPO,
        actorName,
        `${actorName}@gsv.local`,
        `bootstrap root/gsv-manual from ${manualRemoteUrl}#${manualRef}`,
        manualRemoteUrl,
        manualRef,
      ));
      registerBootstrapRepo(ctx, ROOT_GSV_MANUAL_REPO, "GSV Manual");
      setPublicRepo(ctx, ROOT_GSV_MANUAL_REPO);
      return importedManual;
    });
    let imported: Awaited<typeof rootImportPromise>;
    try {
      imported = await rootImportPromise;
    } catch (error) {
      await Promise.allSettled([manualImportPromise]);
      throw error;
    }
    const defaultCliChannel = inferDefaultCliChannel(imported.remoteRef);
    if (!ctx.env.STORAGE) {
      throw new Error("STORAGE binding is required for CLI bootstrap");
    }
    const storage = ctx.env.STORAGE;
    const importedRepo = {
      ...ROOT_GSV_REPO,
      branch: imported.head ?? imported.remoteRef,
    };

    const seedSkillsPromise = limitBootstrap(1, () =>
      timeBootstrapStep(timings, "seed-skills", () => seedRepoSkillsToHome(
        ripgit,
        importedRepo,
        ctx.identity!.process,
      ))
    );

    const refreshCliPromise = refreshCliDownloads(storage, {
      defaultChannel: defaultCliChannel,
      limit: (run) => limitBootstrap(1, run),
      step: (label, run) => timeBootstrapStep(timings, label, run),
    });

    const [, cli, importedManual] = await allSettledOrThrow([
      seedSkillsPromise,
      refreshCliPromise,
      manualImportPromise,
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
      manual: {
        repo: "root/gsv-manual",
        remoteUrl: importedManual.remoteUrl,
        ref: importedManual.remoteRef,
        head: importedManual.head ?? null,
        changed: importedManual.changed,
      },
      cli,
      packages: [],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[sys.bootstrap] ${remoteUrl}#${ref} failed after ${Date.now() - startedAt}ms (${formatBootstrapTimings(timings)}): ${message}`,
    );
    throw error;
  }
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

function resolveManualBootstrapUpstream(env: Env): { remoteUrl: string; ref: string } {
  const configuredUpstream = readEnvString(env, GSV_MANUAL_BOOTSTRAP_UPSTREAM_ENV);
  const configured = configuredUpstream ? parseConfiguredUpstream(configuredUpstream) : undefined;
  return {
    remoteUrl: configured?.remoteUrl ?? DEFAULT_GSV_MANUAL_UPSTREAM_URL,
    ref: readEnvString(env, GSV_MANUAL_BOOTSTRAP_REF_ENV)
      ?? configured?.ref
      ?? DEFAULT_GSV_MANUAL_UPSTREAM_REF,
  };
}

function registerBootstrapRepo(
  ctx: KernelContext,
  repo: Pick<RipgitRepoRef, "owner" | "repo">,
  description: string,
): void {
  const now = String(Date.now());
  const createdKey = repoConfigKey(repo, "created_at");
  if (ctx.config.get(createdKey) === null) {
    ctx.config.set(createdKey, now);
  }
  ctx.config.set(repoConfigKey(repo, "updated_at"), now);
  ctx.config.set(repoConfigKey(repo, "description"), description);
}

function setPublicRepo(ctx: KernelContext, repo: Pick<RipgitRepoRef, "owner" | "repo">): void {
  setRepoVisibility(repo, "public", ctx.config);
}

function repoConfigKey(repo: Pick<RipgitRepoRef, "owner" | "repo">, field: string): string {
  return `repos/${repo.owner}/${repo.repo}/${field}`;
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
