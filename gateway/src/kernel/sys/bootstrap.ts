import type { SysBootstrapArgs, SysBootstrapResult } from "@humansandmachines/gsv/protocol";
import { RipgitClient, type RipgitRepoRef } from "../../fs/ripgit/client";
import type { KernelContext } from "../context";
import { setRepoVisibility } from "../repo-visibility";
import { seedBuiltinSkillsToHome } from "./skills-seed";

const DEFAULT_GSV_MANUAL_UPSTREAM_URL = "https://github.com/deathbyknowledge/gsv-manual";
const DEFAULT_GSV_MANUAL_UPSTREAM_REF = "main";
const GSV_MANUAL_BOOTSTRAP_UPSTREAM_ENV = "GSV_MANUAL_BOOTSTRAP_UPSTREAM";
const GSV_MANUAL_BOOTSTRAP_REF_ENV = "GSV_MANUAL_BOOTSTRAP_REF";
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

export async function handleSysBootstrap(
  args: SysBootstrapArgs | undefined,
  ctx: KernelContext,
): Promise<SysBootstrapResult> {
  if (args && Object.keys(args).length > 0) {
    throw new Error("sys.bootstrap does not accept source overrides");
  }
  if (!ctx.env.RIPGIT) {
    throw new Error("RIPGIT binding is required for system bootstrap");
  }
  if (!ctx.identity) {
    throw new Error("Authenticated identity required");
  }

  const { remoteUrl, ref } = resolveManualBootstrapUpstream(ctx.env);
  const ripgit = new RipgitClient(ctx.env.RIPGIT);
  const actorName = ctx.identity.process.username;
  const startedAt = Date.now();
  const timings: BootstrapTiming[] = [];

  try {
    const imported = await timeBootstrapStep(timings, "import-gsv-manual", () => ripgit.importFromUpstream(
      ROOT_GSV_MANUAL_REPO,
      actorName,
      `${actorName}@gsv.local`,
      `bootstrap root/gsv-manual from ${remoteUrl}#${ref}`,
      remoteUrl,
      ref,
    ));
    registerBootstrapRepo(ctx, ROOT_GSV_MANUAL_REPO, "GSV Manual");
    setPublicRepo(ctx, ROOT_GSV_MANUAL_REPO);
    await timeBootstrapStep(timings, "seed-skills", () => seedBuiltinSkillsToHome(
      ripgit,
      ctx.identity!.process,
    ));

    console.info(
      `[sys.bootstrap] ${remoteUrl}#${ref} completed in ${Date.now() - startedAt}ms (${formatBootstrapTimings(timings)})`,
    );

    return {
      repo: "root/gsv-manual",
      remoteUrl: imported.remoteUrl,
      ref: imported.remoteRef,
      head: imported.head ?? null,
      changed: imported.changed,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[sys.bootstrap] ${remoteUrl}#${ref} failed after ${Date.now() - startedAt}ms (${formatBootstrapTimings(timings)}): ${message}`,
    );
    throw error;
  }
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

function githubRepoUrl(repo: string): string {
  const trimmed = repo.replace(/^\/+|\/+$/g, "");
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(trimmed)) {
    throw new Error(`Invalid bootstrap repo: ${repo}`);
  }
  return `https://github.com/${trimmed}`;
}

function readEnvString(env: Env, name: string): string | undefined {
  const value = (env as unknown as Record<string, unknown>)[name];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function looksLikeGitRemoteUrl(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value) || /^[^@]+@[^:]+:.+$/.test(value);
}
